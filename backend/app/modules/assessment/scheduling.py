"""Working-calendar arithmetic. The calendar is configuration, not a Finvasia policy (OD-BRD-004)."""
from datetime import UTC, date, datetime, time, timedelta
from zoneinfo import ZoneInfo

from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from app.core.config import get_settings
from app.core.enums import ScheduleMode
from app.models import AssessmentConfig, WorkingCalendar

MAX_SEARCH_DAYS = 370


class CalendarView:
    def __init__(self, timezone: str, weekdays: list[int], holidays: set[date]) -> None:
        self.tz = ZoneInfo(timezone)
        self.timezone = timezone
        self.weekdays = set(weekdays)
        self.holidays = holidays

    def is_working(self, day: date) -> bool:
        return day.weekday() in self.weekdays and day not in self.holidays

    def next_working_day(self, day: date) -> date:
        for offset in range(1, MAX_SEARCH_DAYS):
            candidate = day + timedelta(days=offset)
            if self.is_working(candidate):
                return candidate
        raise ValueError("The working calendar has no working day in the next year.")

    def add_working_days(self, day: date, count: int) -> date:
        current = day
        for _ in range(count):
            current = self.next_working_day(current)
        return current

    def working_days_between(self, start: date, end: date) -> int:
        days, current = 0, start
        while current < end:
            current += timedelta(days=1)
            if self.is_working(current):
                days += 1
        return days

    def start_of_day(self, day: date) -> datetime:
        return datetime.combine(day, time.min, self.tz)

    def local_date(self, moment: datetime) -> date:
        return moment.astimezone(self.tz).date()

    def local_time(self, moment: datetime) -> time:
        return moment.astimezone(self.tz).time().replace(second=0, microsecond=0)

    def to_utc(self, day: date, at: time) -> datetime:
        """A wall-clock date and time in this calendar's timezone, as the UTC instant it names.

        Raises ValueError for a time that does not exist there (skipped by a daylight-saving change). A time that
        occurs twice is read as its first occurrence."""
        wall = datetime.combine(day, at.replace(second=0, microsecond=0))
        instant = wall.replace(tzinfo=self.tz).astimezone(UTC)
        if instant.astimezone(self.tz).replace(tzinfo=None) != wall:
            raise ValueError(f"{wall:%Y-%m-%d %H:%M} does not exist in {self.timezone}.")
        return instant


def load_calendar(db: Session) -> CalendarView:
    calendar = db.scalar(select(WorkingCalendar).options(selectinload(WorkingCalendar.holidays)).where(WorkingCalendar.is_default))
    if calendar is None:
        return CalendarView(get_settings().default_timezone, [0, 1, 2, 3, 4], set())
    return CalendarView(calendar.timezone, calendar.working_weekdays, {h.holiday_date for h in calendar.holidays})


def fixed_instant(calendar: CalendarView, config: AssessmentConfig) -> datetime | None:
    """FIXED_DATE: the moment the assessment opens. Configurations saved before a time could be chosen
    (schedule_at empty) open at the start of their day in the organisation timezone, as they always did."""
    if config.schedule_at is not None:
        return config.schedule_at
    if config.schedule_date is not None:
        return calendar.start_of_day(config.schedule_date)
    return None


def calculate_due_at(calendar: CalendarView, completed_at: datetime, config: AssessmentConfig) -> datetime:
    day = calendar.local_date(completed_at)
    if config.schedule_mode == ScheduleMode.SAME_DAY:
        return completed_at
    if config.schedule_mode == ScheduleMode.NEXT_WORKING_DAY:
        return calendar.start_of_day(calendar.next_working_day(day))
    if config.schedule_mode == ScheduleMode.FIXED_DATE:
        # From the chosen moment. Completion recorded on or after it: due at once, never in the past.
        return max(fixed_instant(calendar, config), completed_at)
    if config.schedule_uses_working_days:
        return calendar.start_of_day(calendar.add_working_days(day, config.schedule_delay_days))
    return calendar.start_of_day(day + timedelta(days=config.schedule_delay_days))


def schedule_snapshot(calendar: CalendarView, config: AssessmentConfig) -> dict:
    """Stored with the obligation so a later calendar change cannot silently move this due date (BR §4.3)."""
    return {
        "mode": config.schedule_mode,
        "delay_days": config.schedule_delay_days,
        "date": config.schedule_date.isoformat() if config.schedule_date else None,
        "at": opens.isoformat() if (opens := fixed_instant(calendar, config)) else None,
        "working_days": config.schedule_uses_working_days,
        "timezone": calendar.timezone,
        "weekdays": sorted(calendar.weekdays),
        "config_version": config.version,
    }

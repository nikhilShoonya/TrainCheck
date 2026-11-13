"""Working-calendar arithmetic. The calendar is configuration, not a Finvasia policy (OD-BRD-004)."""
from datetime import date, datetime, time, timedelta
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


def load_calendar(db: Session) -> CalendarView:
    calendar = db.scalar(select(WorkingCalendar).options(selectinload(WorkingCalendar.holidays)).where(WorkingCalendar.is_default))
    if calendar is None:
        return CalendarView(get_settings().default_timezone, [0, 1, 2, 3, 4], set())
    return CalendarView(calendar.timezone, calendar.working_weekdays, {h.holiday_date for h in calendar.holidays})


def calculate_due_at(calendar: CalendarView, completed_at: datetime, config: AssessmentConfig) -> datetime:
    day = calendar.local_date(completed_at)
    if config.schedule_mode == ScheduleMode.SAME_DAY:
        return completed_at
    if config.schedule_mode == ScheduleMode.NEXT_WORKING_DAY:
        return calendar.start_of_day(calendar.next_working_day(day))
    if config.schedule_mode == ScheduleMode.FIXED_DATE:
        # From the start of the chosen day. Completion recorded on or after it: due at once, never in the past.
        return max(calendar.start_of_day(config.schedule_date), completed_at)
    if config.schedule_uses_working_days:
        return calendar.start_of_day(calendar.add_working_days(day, config.schedule_delay_days))
    return calendar.start_of_day(day + timedelta(days=config.schedule_delay_days))


def schedule_snapshot(calendar: CalendarView, config: AssessmentConfig) -> dict:
    """Stored with the obligation so a later calendar change cannot silently move this due date (BR §4.3)."""
    return {
        "mode": config.schedule_mode,
        "delay_days": config.schedule_delay_days,
        "date": config.schedule_date.isoformat() if config.schedule_date else None,
        "working_days": config.schedule_uses_working_days,
        "timezone": calendar.timezone,
        "weekdays": sorted(calendar.weekdays),
        "config_version": config.version,
    }

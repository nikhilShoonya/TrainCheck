"""India-only human display. Storage, import parsing and API ISO timestamps stay separate."""
import re
from datetime import date, datetime
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

INDIA_TIMEZONE = "Asia/Kolkata"
INDIA = ZoneInfo(INDIA_TIMEZONE)


def india_date(moment: datetime) -> date:
    return moment.astimezone(INDIA).date()


def display_date(value: date | datetime) -> str:
    day = india_date(value) if isinstance(value, datetime) else value
    return day.strftime("%d-%m-%Y")


def display_datetime(value: datetime) -> str:
    local = value.astimezone(INDIA)
    return f"{local:%d-%m-%Y} {local.hour % 12 or 12:02d}:{local.minute:02d} {'AM' if local.hour < 12 else 'PM'}"


def filename_stamp(value: datetime) -> str:
    return display_datetime(value).replace(" ", "-").replace(":", "-")


def display_filters(filters: dict) -> str:
    return "; ".join(f"{key}={display_date(date.fromisoformat(value)) if key in ('date_from', 'date_to') else value}" for key, value in filters.items()) or "None"


_LEGACY_MOMENT = re.compile(r"(\d{4}-\d{2}-\d{2} \d{2}:\d{2}) \(([A-Za-z_]+(?:/[A-Za-z_+-]+)*)\)")


def display_legacy_moments(text: str) -> str:
    """Present old generated notification text without rewriting stored notifications."""
    def replace(match: re.Match) -> str:
        try:
            local = datetime.strptime(match[1], "%Y-%m-%d %H:%M").replace(tzinfo=ZoneInfo(match[2]))
        except (ValueError, ZoneInfoNotFoundError):
            return match[0]
        return display_datetime(local)

    return _LEGACY_MOMENT.sub(replace, text)

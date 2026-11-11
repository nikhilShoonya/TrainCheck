"""Password hashing and session tokens."""
import hashlib
import secrets

from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerificationError

_hasher = PasswordHasher()  # Argon2id with the library's current recommended parameters.
_DUMMY_HASH = _hasher.hash("timing-equaliser")


def hash_password(password: str) -> str:
    return _hasher.hash(password)


def verify_password(stored_hash: str | None, password: str) -> bool:
    """Spends the same effort for an unknown account, so timing does not reveal whether it exists."""
    try:
        return _hasher.verify(stored_hash or _DUMMY_HASH, password) and stored_hash is not None
    except (VerificationError, InvalidHashError):
        return False


def needs_rehash(stored_hash: str) -> bool:
    return _hasher.check_needs_rehash(stored_hash)


def new_token() -> str:
    return secrets.token_urlsafe(32)


def hash_token(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def validate_password_strength(password: str) -> str | None:
    """Returns a message if the password is too weak. Final policy awaits Finvasia Security."""
    if len(password) < 10:
        return "Use at least 10 characters."
    if password.lower() == password or password.upper() == password or not any(c.isdigit() for c in password):
        return "Use upper-case and lower-case letters and at least one number."
    return None

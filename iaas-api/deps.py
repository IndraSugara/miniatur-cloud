from fastapi import Depends, HTTPException
from fastapi.security import OAuth2PasswordBearer
from jose import JWTError, jwt
from passlib.context import CryptContext
from sqlalchemy.orm import Session
from datetime import datetime, timedelta

from config import SECRET_KEY, ALGORITHM, TOKEN_EXPIRE, REFRESH_TOKEN_EXPIRE
from database import get_db
from errors import invalid_token, admin_only
from models import User

pwd_ctx = CryptContext(schemes=["bcrypt"], deprecated="auto")
oauth2  = OAuth2PasswordBearer(tokenUrl="/auth/token")


def hash_password(pw):
    return pwd_ctx.hash(pw)


def verify_password(plain, hashed):
    return pwd_ctx.verify(plain, hashed)


def create_token(data: dict):
    """Create a short-lived access token."""
    payload = data.copy()
    payload["type"] = "access"
    payload["exp"] = datetime.utcnow() + timedelta(minutes=TOKEN_EXPIRE)
    return jwt.encode(payload, SECRET_KEY, algorithm=ALGORITHM)


def create_refresh_token(data: dict):
    """Create a long-lived refresh token (7 days)."""
    payload = data.copy()
    payload["type"] = "refresh"
    payload["exp"] = datetime.utcnow() + timedelta(minutes=REFRESH_TOKEN_EXPIRE)
    return jwt.encode(payload, SECRET_KEY, algorithm=ALGORITHM)


def decode_refresh_token(token: str) -> str:
    """Decode a refresh token and return the username.

    Raises IaaSError if token is invalid or not a refresh token.
    """
    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
        if payload.get("type") != "refresh":
            invalid_token()
        username = payload.get("sub")
        if not username:
            invalid_token()
        return username
    except JWTError:
        invalid_token()


def get_current_user(token: str = Depends(oauth2), db: Session = Depends(get_db)):
    try:
        payload  = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
        if payload.get("type") not in ("access", None):
            invalid_token()
        username = payload.get("sub")
        if not username:
            invalid_token()
        user = db.query(User).filter(User.username == username).first()
        if not user:
            invalid_token()
        return user
    except JWTError:
        invalid_token()


def require_admin(user: User = Depends(get_current_user)):
    if not user.is_admin:
        admin_only()
    return user

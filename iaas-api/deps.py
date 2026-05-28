from fastapi import Depends, HTTPException
from fastapi.security import OAuth2PasswordBearer
from jose import JWTError, jwt
from passlib.context import CryptContext
from sqlalchemy.orm import Session
from datetime import datetime, timedelta

from config import SECRET_KEY, ALGORITHM, TOKEN_EXPIRE
from database import get_db
from models import User

pwd_ctx = CryptContext(schemes=["bcrypt"], deprecated="auto")
oauth2  = OAuth2PasswordBearer(tokenUrl="/auth/token")


def hash_password(pw):
    return pwd_ctx.hash(pw)


def verify_password(plain, hashed):
    return pwd_ctx.verify(plain, hashed)


def create_token(data: dict):
    payload = data.copy()
    payload["exp"] = datetime.utcnow() + timedelta(minutes=TOKEN_EXPIRE)
    return jwt.encode(payload, SECRET_KEY, algorithm=ALGORITHM)


def get_current_user(token: str = Depends(oauth2), db: Session = Depends(get_db)):
    exc = HTTPException(status_code=401, detail="Token tidak valid",
                        headers={"WWW-Authenticate": "Bearer"})
    try:
        payload  = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
        username = payload.get("sub")
        if not username:
            raise exc
        user = db.query(User).filter(User.username == username).first()
        if not user:
            raise exc
        return user
    except JWTError:
        raise exc


def require_admin(user: User = Depends(get_current_user)):
    if not user.is_admin:
        raise HTTPException(403, "Hanya admin yang bisa akses")
    return user

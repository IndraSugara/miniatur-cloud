from __future__ import annotations

import logging
import uuid

from fastapi import APIRouter, Depends, HTTPException
from fastapi.security import OAuth2PasswordRequestForm
from sqlalchemy.orm import Session

from cache import check_rate_limit, get_redis
from database import get_db
from deps import create_token, get_current_user, hash_password, require_admin, verify_password
from models import User
from schemas import UserRegister

router = APIRouter(tags=["Auth"])
audit = logging.getLogger("iaas.audit")


@router.post("/auth/register")
def register(body: UserRegister, db: Session = Depends(get_db)):
    if db.query(User).filter(User.username == body.username).first():
        raise HTTPException(409, "Username sudah dipakai")
    user = User(
        id=str(uuid.uuid4()), username=body.username,
        email=body.email,
        hashed_password=hash_password(body.password),
    )
    db.add(user)
    db.commit()
    audit.info("USER_REGISTER user=%s", body.username)
    return {"message": "Registrasi berhasil", "username": body.username}


@router.post("/auth/token")
def login(form: OAuth2PasswordRequestForm = Depends(), db: Session = Depends(get_db)):
    rl_key = f"rl:auth:{form.username}"
    if check_rate_limit(rl_key, max_attempts=10, window=60):
        raise HTTPException(429, "Terlalu banyak percobaan login. Coba lagi nanti.")
    user = db.query(User).filter(User.username == form.username).first()
    if not user or not verify_password(form.password, user.hashed_password):
        audit.warning("LOGIN_FAIL user=%s", form.username)
        raise HTTPException(401, "Username atau password salah")
    r = get_redis()
    if r:
        r.delete(rl_key)
    audit.info("LOGIN_OK user=%s", user.username)
    return {"access_token": create_token({"sub": user.username}), "token_type": "bearer"}


@router.get("/auth/me")
def me(user: User = Depends(get_current_user)):
    return {"id": user.id, "username": user.username,
            "email": user.email, "is_admin": user.is_admin,
            "quota_instances": user.quota_instances}


@router.get("/admin/users", tags=["Admin"])
def list_users(admin: User = Depends(require_admin), db: Session = Depends(get_db)):
    users = db.query(User).order_by(User.created_at.desc()).all()
    return {
        "users": [
            {
                "id": u.id,
                "username": u.username,
                "email": u.email,
                "is_admin": u.is_admin,
                "is_active": u.is_active,
                "quota_instances": u.quota_instances,
                "created_at": str(u.created_at),
            }
            for u in users
        ]
    }

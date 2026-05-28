import json
import logging

import redis

from config import REDIS_URL

log = logging.getLogger("iaas.cache")

try:
    _redis = redis.Redis.from_url(REDIS_URL, decode_responses=True, socket_connect_timeout=2)
    _redis.ping()
    log.info("Redis connected: %s", REDIS_URL)
except Exception as _e:
    _redis = None
    log.warning("Redis unavailable (%s), running without cache/rate-limit", _e)


def get_redis():
    """Return the Redis client (or None if unavailable)."""
    return _redis


def cache_get(key: str):
    if not _redis:
        return None
    raw = _redis.get(key)
    return json.loads(raw) if raw else None


def cache_set(key: str, value, ttl: int = 5):
    if not _redis:
        return
    _redis.setex(key, ttl, json.dumps(value))


def check_rate_limit(key: str, max_attempts: int = 10, window: int = 60) -> bool:
    """Return True if rate limit exceeded."""
    if not _redis:
        return False
    current = _redis.incr(key)
    if current == 1:
        _redis.expire(key, window)
    return current > max_attempts

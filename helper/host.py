"""Quick Video Saver local helper (Chrome native-messaging host).

Standard library only. No HTTP server: the browser talks to this process over
stdin/stdout using length-prefixed JSON.  Heavy lifting is delegated to the
bundled yt-dlp / FFmpeg / Deno binaries, wrapped in a "retry ladder" that
changes the way a download is attempted whenever a site refuses the first try.
"""
import base64
import collections
import concurrent.futures
import ctypes
import hashlib
import json
import math
import os
from pathlib import Path
import re
import shutil
import struct
import subprocess
import sys
import tempfile
import threading
import time
import unicodedata
from urllib.parse import urlsplit
import uuid

VERSION = "2.0.0"
ROOT = Path(__file__).resolve().parent
RUNTIME = ROOT / "runtime"
HOST_NAME = "com.quick_video_saver.local"
CREATE_NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)
MAX_INCOMING = 32 * 1024 * 1024
MAX_OUTGOING = 900 * 1024
MEDIA_EXTS = {".mp4", ".mkv", ".webm", ".mov", ".m4v", ".mp3", ".m4a", ".aac", ".opus", ".ogg", ".wav", ".flac", ".ts", ".flv", ".avi", ".wmv", ".mpg", ".mpeg", ".3gp", ".ogv"}
PARTIAL_DIR = ".partial"

OUT_LOCK = threading.Lock()
SCHED_LOCK = threading.RLock()
JOBS = {}
QUEUE = collections.deque()
KNOWN_FILES = set()
TAKEN_STEMS = set()
STOPPING = threading.Event()
UPDATING = threading.Event()
POOL = concurrent.futures.ThreadPoolExecutor(max_workers=6)
PROBE_SLOTS = threading.Semaphore(3)
PROBES = {}
PROBES_LOCK = threading.Lock()
TOOL_STATE = {"impersonate": None, "ytdlp": None, "ffmpeg": None, "updated": 0}

CONFIG = {
    "folder": "",
    "parallel": 2,
    "container": "mp4",      # mp4 | mkv
    "audioFormat": "mp3",    # mp3 | m4a
    "preferCompat": True,    # H.264 / AAC when the resolution is equal
    "subtitles": False,
    "fragments": 6,
    "autoUpdate": True,
    "impersonate": True,
}

HEADER_DENY = {
    "host", "connection", "content-length", "content-type", "content-encoding", "accept-encoding", "accept", "range", "if-range", "if-none-match",
    "if-modified-since", "cache-control", "pragma", "te", "upgrade", "upgrade-insecure-requests", "dnt", "cookie", "cookie2", "priority",
    "transfer-encoding", "expect", "keep-alive", "via", "forwarded", "x-client-data", "purpose", "referer", "user-agent", "origin", "authority",
}


# ----------------------------------------------------------------- protocol --
def read_exact(stream, size):
    data = bytearray()
    while len(data) < size:
        chunk = stream.read(size - len(data))
        if not chunk:
            if not data:
                return None
            raise ValueError("Truncated native message.")
        data.extend(chunk)
    return bytes(data)


def read_message(stream):
    header = read_exact(stream, 4)
    if header is None:
        return None
    length = struct.unpack("<I", header)[0]
    if not 0 < length <= MAX_INCOMING:
        raise ValueError("Native message is too large.")
    payload = read_exact(stream, length)
    if payload is None:
        raise ValueError("Missing native message body.")
    value = json.loads(payload.decode("utf-8"))
    if not isinstance(value, dict):
        raise ValueError("Expected a message object.")
    return value


def send(message):
    if STOPPING.is_set():
        return
    body = json.dumps(message, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    if len(body) > MAX_OUTGOING:
        # Chrome rejects native replies above 1 MB; degrade instead of dying.
        message = {k: v for k, v in message.items() if k not in ("info", "diag")}
        message.update(ok=False, error="The helper reply was too large to deliver.")
        body = json.dumps(message, ensure_ascii=False).encode("utf-8")
    try:
        with OUT_LOCK:
            sys.stdout.buffer.write(struct.pack("<I", len(body)) + body)
            sys.stdout.buffer.flush()
    except (BrokenPipeError, OSError):
        STOPPING.set()


# --------------------------------------------------------------- filesystem --
def known_folder_downloads():
    if os.name == "nt":
        try:
            from ctypes import wintypes
            shell = ctypes.WinDLL("shell32")
            ole = ctypes.WinDLL("ole32")
            shell.SHGetKnownFolderPath.argtypes = [ctypes.c_void_p, wintypes.DWORD, wintypes.HANDLE, ctypes.POINTER(ctypes.c_void_p)]
            shell.SHGetKnownFolderPath.restype = ctypes.c_long
            ole.CoTaskMemFree.argtypes = [ctypes.c_void_p]
            folder_id = ctypes.create_string_buffer(uuid.UUID("374de290-123f-4565-9164-39c4925e467b").bytes_le)
            pointer = ctypes.c_void_p()
            if shell.SHGetKnownFolderPath(folder_id, 0, None, ctypes.byref(pointer)) == 0:
                try:
                    return Path(ctypes.wstring_at(pointer))
                finally:
                    ole.CoTaskMemFree(pointer)
        except Exception:
            pass
    return Path.home() / "Downloads"


def default_folder():
    return known_folder_downloads() / "Quick Video Saver"


def downloads_folder():
    custom = CONFIG.get("folder")
    if custom:
        return Path(custom)
    return default_folder()


def partial_folder():
    return downloads_folder() / PARTIAL_DIR


def ensure_folder(path):
    path.mkdir(parents=True, exist_ok=True)
    probe = path / (".qvs-write-test-" + uuid.uuid4().hex[:8])
    probe.write_bytes(b"x")
    probe.unlink()
    return path


RESERVED_NAME = re.compile(r"^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$", re.I)


def safe_stem(text, limit=150, fallback="Video"):
    """Turn arbitrary page titles into a Windows-safe file name stem."""
    text = unicodedata.normalize("NFC", str(text or ""))
    text = re.sub(r"[\x00-\x1f\x7f\u200b-\u200f\u202a-\u202e\u2060\ufeff]", "", text)
    text = text.replace(":", " -").replace("|", "-").replace("/", "-").replace("\\", "-").replace('"', "'")
    text = re.sub(r"[<>*?]", "", text)
    text = re.sub(r"\s+", " ", text).strip(" .-")
    text = text[:limit].strip(" .-")
    if not text:
        text = fallback
    if RESERVED_NAME.match(text):
        text = "_" + text
    return text


def stem_limit(folder):
    # Keep full paths below the classic 260 character MAX_PATH.
    return max(40, min(150, 235 - len(str(folder)) - len(PARTIAL_DIR) - 12))


def stem_exists(folder, stem):
    """True when a finished file or a leftover partial already uses this stem."""
    low = stem.lower()
    for where, partial in ((folder, False), (folder / PARTIAL_DIR, True)):
        try:
            with os.scandir(where) as entries:
                for entry in entries:
                    name = entry.name.lower()
                    if name.startswith(low + ".") and (partial or Path(name).suffix in MEDIA_EXTS):
                        return True
        except OSError:
            pass
    return False


def reserve_stem(folder, wanted):
    """Pick a stem nobody else is using: 'Title', 'Title (2)', ..."""
    with SCHED_LOCK:
        base = wanted
        n = 1
        while True:
            candidate = base if n == 1 else f"{base} ({n})"
            if candidate.lower() not in TAKEN_STEMS and not stem_exists(folder, candidate):
                TAKEN_STEMS.add(candidate.lower())
                return candidate
            n += 1
            if n > 500:
                candidate = f"{base} ({uuid.uuid4().hex[:6]})"
                TAKEN_STEMS.add(candidate.lower())
                return candidate


def release_stem(stem):
    with SCHED_LOCK:
        TAKEN_STEMS.discard(str(stem).lower())


def tool(name):
    paths = {
        "yt-dlp": RUNTIME / "yt-dlp.exe",
        "ffmpeg": RUNTIME / "ffmpeg" / "bin" / "ffmpeg.exe",
        "ffprobe": RUNTIME / "ffmpeg" / "bin" / "ffprobe.exe",
        "deno": RUNTIME / "deno" / "deno.exe",
    }
    return paths[name]


executable = tool  # name kept for older tests


def ready():
    return all(tool(name).is_file() for name in ("yt-dlp", "ffmpeg", "ffprobe", "deno"))


def run_quiet(args, timeout=20, env=None):
    return subprocess.run(args, capture_output=True, timeout=timeout, creationflags=CREATE_NO_WINDOW, env=env, stdin=subprocess.DEVNULL)


def tool_versions(fetch=False):
    """Cached tool versions; spawning the tools only happens in background threads."""
    if fetch and TOOL_STATE["ytdlp"] is None and tool("yt-dlp").is_file():
        try:
            TOOL_STATE["ytdlp"] = run_quiet([str(tool("yt-dlp")), "--version"], 60).stdout.decode("utf-8", "replace").strip()
        except Exception:
            TOOL_STATE["ytdlp"] = ""
    if fetch and TOOL_STATE["ffmpeg"] is None and tool("ffmpeg").is_file():
        try:
            first = run_quiet([str(tool("ffmpeg")), "-version"], 20).stdout.decode("utf-8", "replace").splitlines()[0]
            TOOL_STATE["ffmpeg"] = first.replace("ffmpeg version", "").strip().split(" ")[0]
        except Exception:
            TOOL_STATE["ffmpeg"] = ""
    return {"ytdlp": TOOL_STATE["ytdlp"] or "", "ffmpeg": TOOL_STATE["ffmpeg"] or ""}


def detect_tools():
    tool_versions(fetch=True)
    try:
        out = run_quiet([str(tool("yt-dlp")), "--list-impersonate-targets"], 60).stdout.decode("utf-8", "replace")
        TOOL_STATE["impersonate"] = bool(re.search(r"chrome.*curl_cffi", out, re.I))
    except Exception:
        TOOL_STATE["impersonate"] = False
    send({"event": "tools", **public_tools()})


def public_tools():
    return {"tools": tool_versions(), "impersonate": TOOL_STATE["impersonate"], "ready": ready()}


# -------------------------------------------------------------- validation --
def validate_url(value):
    if not isinstance(value, str) or len(value) > 16000 or re.search(r"[\x00-\x20\x7f]", value):
        raise ValueError("Invalid video URL.")
    parsed = urlsplit(value)
    if parsed.scheme not in ("http", "https") or not parsed.hostname or parsed.username or parsed.password:
        raise ValueError("Only http and https video/page links are supported.")
    return value


def clean_headers(headers):
    """Keep only request headers that are useful and safe to replay."""
    result = {}
    if not isinstance(headers, dict):
        return result
    for key, value in list(headers.items())[:60]:
        name = str(key).strip()
        text = str(value).strip()
        low = name.lower()
        if not re.fullmatch(r"[A-Za-z0-9-]{1,60}", name) or low in HEADER_DENY or low.startswith(("sec-", "proxy-")):
            continue
        if not text or len(text) > 4096 or re.search(r"[\r\n\x00]", text):
            continue
        result[name] = text
        if len(result) >= 16:
            break
    return result


def pick_header(headers, name):
    if not isinstance(headers, dict):
        return ""
    for key, value in headers.items():
        if str(key).lower() == name:
            text = str(value).strip()
            if text and len(text) <= 4096 and not re.search(r"[\r\n\x00]", text):
                return text
    return ""


def cookie_matches(cookie, host, path, secure):
    domain = str(cookie.get("domain", "")).lower()
    base = domain.lstrip(".")
    if not base:
        return False
    # A leading dot means "this domain and its subdomains"; otherwise host-only.
    if not (host == base or (domain.startswith(".") and host.endswith("." + base))):
        return False
    if not path.startswith(str(cookie.get("path", "/")) or "/"):
        return False
    return secure or not cookie.get("secure")


def safe_url(value):
    try:
        return validate_url(value)
    except ValueError:
        return ""


def clean_cookies(cookies, urls):
    if not cookies:
        return []
    if not isinstance(cookies, list) or len(cookies) > 4000:
        raise ValueError("Invalid site cookies.")
    hosts = [(urlsplit(url).hostname or "").lower() for url in urls if url]
    result = []
    for cookie in cookies:
        if not isinstance(cookie, dict):
            continue
        domain = str(cookie.get("domain", ""))
        base = domain.lstrip(".").lower()
        if not base or not any(host == base or host.endswith("." + base) for host in hosts):
            continue
        fields = [domain, str(cookie.get("path", "/")), str(cookie.get("name", "")), str(cookie.get("value", ""))]
        if any(re.search(r"[\x00-\x1f\x7f]", field) for field in fields) or not fields[2]:
            continue
        result.append(cookie)
    return result


def write_cookies(cookies, urls):
    kept = clean_cookies(cookies, urls)
    if not kept:
        return None
    lines = ["# Netscape HTTP Cookie File"]
    for cookie in kept:
        domain = str(cookie.get("domain", ""))
        lines.append("\t".join([
            domain, "TRUE" if domain.startswith(".") else "FALSE", str(cookie.get("path", "/")),
            "TRUE" if cookie.get("secure") else "FALSE", str(int(cookie.get("expirationDate") or 0)),
            str(cookie.get("name", "")), str(cookie.get("value", "")),
        ]))
    fd, filename = tempfile.mkstemp(prefix="qvs-cookies-", suffix=".txt")
    with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as file:
        file.write("\n".join(lines) + "\n")
    return filename


def cookie_header(cookies, url):
    parts = urlsplit(url)
    host = (parts.hostname or "").lower()
    return "; ".join(f"{c['name']}={c['value']}" for c in clean_cookies(cookies, [url]) if cookie_matches(c, host, parts.path or "/", parts.scheme == "https"))


# ------------------------------------------------------------ error mapping --
ERROR_RULES = [
    ("drm", re.compile(r"\bDRM\b|widevine|playready|fairplay|encrypted with (?:a )?(?:key|drm)", re.I)),
    ("disk_full", re.compile(r"No space left|disk full|ENOSPC|not enough space", re.I)),
    ("permission", re.compile(r"Permission denied|Access is denied|WinError 5\b|PermissionError", re.I)),
    ("login_required", re.compile(r"sign in|log ?in (?:is )?required|login required|logged[- ]?in|use --cookies|--cookies-from-browser|private video|members[- ]only|premium|subscribe to|age[- ]restricted|confirm your age|confirm you.re not a bot|requires authentication", re.I)),
    ("geo", re.compile(r"geo[- ]?(?:restrict|block)|not available in your (?:country|region)|your location", re.I)),
    ("rate_limited", re.compile(r"HTTP Error 429|Too Many Requests", re.I)),
    ("auth", re.compile(r"HTTP Error 401|Unauthorized", re.I)),
    ("forbidden", re.compile(r"HTTP Error 403|Forbidden|Cloudflare|captcha|access denied", re.I)),
    ("gone", re.compile(r"HTTP Error (?:404|410)|Not Found|Gone\b|video (?:is )?(?:no longer|unavailable)|has been removed", re.I)),
    ("not_media", re.compile(r"not_media|did not contain (?:a )?(?:video|audio)|Invalid data found when processing input|moov atom not found", re.I)),
    ("unsupported", re.compile(r"Unsupported URL|No video formats found|no video could be found|Unable to find (?:a )?video|There is no video", re.I)),
    ("postprocess", re.compile(r"Postprocessing|Conversion failed|Could not write header|codec not currently supported in container|Error (?:initializing|muxing)|Remux", re.I)),
    ("extractor", re.compile(r"Unable to extract|unable to download (?:video|webpage)|Extractor error|please report this issue|nsig|signature extraction|JSON|player response", re.I)),
    ("network", re.compile(r"urlopen error|timed out|Connection (?:reset|refused|aborted)|Name or service not known|getaddrinfo|SSL|Temporary failure|Network is unreachable|IncompleteRead|Read timed out", re.I)),
    ("scheduled", re.compile(r"live event will begin|premieres in|will begin in", re.I)),
]
TERMINAL_CODES = {"drm", "disk_full", "permission", "login_required", "geo", "rate_limited", "cancelled", "tool_missing", "scheduled"}


def classify_error(text):
    text = str(text or "")
    for code, rule in ERROR_RULES:
        if rule.search(text):
            return code
    return "unknown"


# ------------------------------------------------------------- yt-dlp args --
PROGRESS_TEMPLATE = 'download:QVS_PROGRESS:{"d":%(progress.downloaded_bytes|0)s,"t":%(progress.total_bytes|0)s,"e":%(progress.total_bytes_estimate|0)s,"s":%(progress.speed|0)s,"r":%(progress.eta|0)s,"fi":%(progress.fragment_index|0)s,"fc":%(progress.fragment_count|0)s}'


def number(value):
    try:
        value = float(value or 0)
        return value if math.isfinite(value) and value >= 0 else 0
    except (ValueError, TypeError):
        return 0


def format_selector(spec, mkv=False):
    """Return (-f selector, extra args) for the requested quality."""
    cfg = CONFIG
    if spec.get("audioOnly") or spec.get("quality") == "audio":
        fmt = "m4a" if cfg.get("audioFormat") == "m4a" else "mp3"
        return "bestaudio/best", ["--extract-audio", "--audio-format", fmt, "--audio-quality", "0"]
    sort = ["-S", "res,fps,vcodec:h264,acodec:aac,ext:mp4:m4a"] if cfg.get("preferCompat", True) else ["-S", "res,fps"]
    extra = sort + ["--merge-output-format", "mkv" if mkv else "mp4/mkv"]
    fid = spec.get("formatId")
    if isinstance(fid, str) and re.fullmatch(r"[A-Za-z0-9_.\-+]{1,60}", fid):
        selector = fid if spec.get("hasAudio") else f"{fid}+ba/{fid}"
        return selector, extra
    try:
        height = int(spec.get("height") or spec.get("quality") or 0)
    except (TypeError, ValueError):
        height = 0
    if 40 <= height <= 8640:
        cap = f"[height<=?{height}]"
        return f"bv*{cap}+ba/b{cap}", extra
    return "bv*+ba/b", extra


def build_ytdlp(job, attempt, target_url):
    msg = job["msg"]
    cfg = CONFIG
    spec = msg.get("format") or {}
    folder = job["folder"]
    template = job["stem"].replace("%", "%%") + ".%(ext)s"
    args = [
        str(tool("yt-dlp")), "--ignore-config", "--no-playlist", "--playlist-items", "1", "--no-simulate", "--newline", "--no-colors",
        "--progress", "--progress-delta", "0.4", "--windows-filenames", "--trim-filenames", "200", "--no-overwrites", "--continue",
        "--socket-timeout", "30", "--retries", "6", "--extractor-retries", "3", "--fragment-retries", "6",
        "--retry-sleep", "fragment:exp=1:8", "--retry-sleep", "http:exp=1:8",
        "--concurrent-fragments", str(max(1, min(16, int(cfg.get("fragments", 6))))), "--abort-on-unavailable-fragments",
        "--ffmpeg-location", str(tool("ffmpeg").parent), "--js-runtimes", "deno:" + str(tool("deno")),
        "--paths", f"home:{folder}", "--paths", f"temp:{folder / PARTIAL_DIR}", "--output", template,
        "--print", "before_dl:QVS_TITLE:%(title)j", "--print", "after_move:QVS_FILE:%(filepath)j", "--progress-template", PROGRESS_TEMPLATE,
    ]
    mkv = cfg.get("container") == "mkv" or bool(attempt.get("noremux"))
    selector, extra = format_selector(spec, mkv)
    args += ["-f", selector] + extra
    if not attempt.get("noremux") and not (spec.get("audioOnly") or spec.get("quality") == "audio"):
        args += ["--remux-video", "mkv" if mkv else "mp4/mkv"]
    if msg.get("live"):
        args += ["--hls-use-mpegts"]
    if cfg.get("subtitles"):
        args += ["--write-subs", "--sub-langs", "en.*,hi.*,-live_chat", "--convert-subs", "srt"]
    request_headers = msg.get("headers")
    referer = safe_url(pick_header(request_headers, "referer")) or (safe_url(msg.get("pageURL")) if attempt.get("level") != "page" else "")
    if referer:
        args += ["--referer", referer]
    agent = pick_header(request_headers, "user-agent")
    if agent:
        args += ["--user-agent", agent]
    origin = pick_header(request_headers, "origin")
    if origin:
        args += ["--add-header", f"Origin:{origin}"]
    for name, value in job["headers"].items():
        args += ["--add-header", f"{name}:{value}"]
    if attempt.get("impersonate"):
        args += ["--impersonate", "chrome"]
    if job.get("cookie_file"):
        args += ["--cookies", job["cookie_file"]]
    args += ["--", target_url]
    return args


def command(message, folder, cookie_file=None, attempt=None):
    """Build the yt-dlp command line for a start message (also used by tests)."""
    job = {"msg": message, "folder": Path(folder), "stem": safe_stem(message.get("filename") or "Video"), "headers": clean_headers(message.get("headers")), "cookie_file": cookie_file}
    return build_ytdlp(job, attempt or {}, validate_url(message.get("url")))


# --------------------------------------------------------------- ffprobe ----
def is_hls(url, kind=""):
    return kind == "hls" or bool(re.search(r"\.m3u8?(?:$|[?#])", str(url), re.I))


# Private demuxer options: FFmpeg rejects them (instead of ignoring them) for other formats.
HLS_INPUT_OPTIONS = ["-allowed_extensions", "ALL", "-extension_picky", "0"]


def ffprobe_args(source, headers=None, cookies="", extra=(), kind=""):
    args = [str(tool("ffprobe")), "-v", "error", "-print_format", "json", "-show_format", "-show_streams", *extra]
    if str(source).startswith("http"):
        header_lines = ""
        if headers:
            referer = pick_header(headers, "referer")
            origin = pick_header(headers, "origin")
            header_lines = (f"Referer: {referer}\r\n" if referer else "") + (f"Origin: {origin}\r\n" if origin else "")
            header_lines += "".join(f"{k}: {v}\r\n" for k, v in clean_headers(headers).items())
        if cookies:
            header_lines += f"Cookie: {cookies}\r\n"
        agent = pick_header(headers, "user-agent")
        if agent:
            args += ["-user_agent", agent]
        if header_lines:
            args += ["-headers", header_lines]
        args += ["-rw_timeout", "20000000"]
        if is_hls(source, kind):
            args += HLS_INPUT_OPTIONS
    args += [str(source)]
    return args


def run_ffprobe(source, headers=None, cookies="", timeout=40, extra=(), kind=""):
    result = run_quiet(ffprobe_args(source, headers, cookies, extra, kind), timeout)
    if result.returncode != 0 and is_hls(source, kind) and b"extension_picky" in result.stderr:
        args = ffprobe_args(source, headers, cookies, extra, kind)
        del args[args.index("-extension_picky"):][:2]
        result = run_quiet(args, timeout)
    if result.returncode != 0:
        raise RuntimeError(result.stderr.decode("utf-8", "replace").strip().splitlines()[-1] if result.stderr.strip() else "ffprobe failed")
    return json.loads(result.stdout.decode("utf-8", "replace") or "{}")


def frame_rate(value):
    try:
        a, b = str(value).split("/")
        return round(int(a) / int(b), 2) if int(b) else 0
    except (ValueError, ZeroDivisionError):
        return 0


def summarize_ffprobe(data):
    streams = data.get("streams") or []
    fmt = data.get("format") or {}
    video = next((s for s in streams if s.get("codec_type") == "video" and not (s.get("disposition") or {}).get("attached_pic")), None)
    audio = next((s for s in streams if s.get("codec_type") == "audio"), None)
    out = {
        "container": str(fmt.get("format_name", "")).split(",")[0],
        "duration": number(fmt.get("duration")) or number((video or audio or {}).get("duration")),
        "size": int(number(fmt.get("size"))),
        "bitrate": int(number(fmt.get("bit_rate"))),
        "hasVideo": bool(video),
        "hasAudio": bool(audio),
    }
    if video:
        out.update(width=int(video.get("width") or 0), height=int(video.get("height") or 0), fps=frame_rate(video.get("avg_frame_rate") or video.get("r_frame_rate")), vcodec=video.get("codec_name", ""))
    if audio:
        out.update(acodec=audio.get("codec_name", ""))
    return out


def verify_media(path):
    """True when the file really contains audio or video (guards against saved error pages)."""
    try:
        info = summarize_ffprobe(run_ffprobe(str(path), timeout=40))
        return (info["hasVideo"] or info["hasAudio"]), info
    except Exception as error:
        return False, {"error": str(error)}


# ----------------------------------------------------------------- probing ---
def codec_family(code):
    code = str(code or "").lower()
    if code in ("none", ""):
        return ""
    for key, name in (("avc", "h264"), ("h264", "h264"), ("hev", "h265"), ("hvc", "h265"), ("h265", "h265"), ("vp09", "vp9"), ("vp9", "vp9"), ("vp8", "vp8"), ("av01", "av1"), ("av1", "av1"), ("mp4a", "aac"), ("aac", "aac"), ("opus", "opus"), ("vorbis", "vorbis"), ("mp3", "mp3"), ("ac-3", "ac3"), ("ec-3", "eac3")):
        if code.startswith(key):
            return name
    return code.split(".")[0]


def format_size(fmt, duration):
    size = fmt.get("filesize") or fmt.get("filesize_approx")
    approx = False
    if not size and fmt.get("tbr") and duration:
        size = fmt["tbr"] * 1000 / 8 * duration
        approx = True
    return (int(size) if size else 0), approx or bool(fmt.get("filesize_approx")) and not fmt.get("filesize")


def build_qualities(info):
    duration = number(info.get("duration"))
    formats = info.get("formats") or []
    videos, audios = [], []
    for fmt in formats:
        if fmt.get("has_drm") or str(fmt.get("format_note", "")).lower() == "storyboard" or fmt.get("protocol") == "mhtml":
            continue
        has_v = codec_family(fmt.get("vcodec")) != "" or (fmt.get("vcodec") in (None,) and fmt.get("height"))
        has_a = codec_family(fmt.get("acodec")) != ""
        if has_v and fmt.get("height"):
            videos.append((fmt, has_a))
        elif has_a and not has_v:
            audios.append(fmt)
    best_audio = None
    if audios:
        best_audio = max(audios, key=lambda f: ((f.get("ext") in ("m4a", "mp4")) if CONFIG.get("preferCompat", True) else 0, f.get("abr") or f.get("tbr") or 0))
    by_height = {}
    for fmt, has_a in videos:
        by_height.setdefault(int(fmt["height"]), []).append((fmt, has_a))
    qualities = []
    for height, group in by_height.items():
        def rank(item):
            fmt, has_a = item
            family = codec_family(fmt.get("vcodec"))
            return (1 if (CONFIG.get("preferCompat", True) and family == "h264") else 0, fmt.get("fps") or 0, fmt.get("tbr") or 0)
        fmt, has_a = max(group, key=rank)
        size, approx = format_size(fmt, duration)
        if not has_a and best_audio:
            audio_size, audio_approx = format_size(best_audio, duration)
            size += audio_size
            approx = approx or audio_approx
        fps = int(fmt.get("fps") or 0)
        qualities.append({
            "height": height, "width": int(fmt.get("width") or 0), "fps": fps, "label": f"{height}p" + (str(fps) if fps > 30 else ""),
            "vcodec": codec_family(fmt.get("vcodec")), "ext": fmt.get("ext") or "", "size": size, "approx": approx, "formatId": str(fmt.get("format_id", "")),
            "hasAudio": has_a, "hdr": bool(fmt.get("dynamic_range") and fmt.get("dynamic_range") != "SDR"),
        })
    qualities.sort(key=lambda q: -q["height"])
    audio = None
    if best_audio:
        size, approx = format_size(best_audio, duration)
        audio = {"formatId": str(best_audio.get("format_id", "")), "ext": best_audio.get("ext") or "", "abr": int(best_audio.get("abr") or best_audio.get("tbr") or 0), "size": size, "approx": approx}
    return qualities, audio


def normalize_info(info):
    if not isinstance(info, dict):
        raise RuntimeError("The downloader returned nothing readable.")
    entries = info.get("entries")
    if info.get("_type") in ("playlist", "multi_video") or entries is not None:
        items = [e for e in (entries or []) if isinstance(e, dict)]
        if len(items) == 1 and (items[0].get("formats") or items[0].get("url")):
            merged = dict(items[0])
            merged.setdefault("extractor_key", info.get("extractor_key"))
            merged.setdefault("webpage_url", info.get("webpage_url"))
            return normalize_info(merged)
        return {
            "kind": "playlist", "extractor": info.get("extractor_key") or "", "site": info.get("extractor") or "", "title": info.get("title") or "", "webpage_url": info.get("webpage_url") or "",
            "entries": [{"title": str(e.get("title") or "")[:200], "url": e.get("webpage_url") or e.get("url") or "", "duration": number(e.get("duration")), "thumbnail": e.get("thumbnail") or (e.get("thumbnails") or [{}])[-1].get("url", "")} for e in items[:60] if (e.get("webpage_url") or e.get("url"))],
            "count": len(items),
        }
    qualities, audio = build_qualities(info)
    thumbnail = info.get("thumbnail") or ""
    if not thumbnail and info.get("thumbnails"):
        thumbnail = (info["thumbnails"][-1] or {}).get("url", "")
    drm = bool(info.get("formats")) and all(f.get("has_drm") for f in info["formats"] if f.get("vcodec") != "none")
    return {
        "kind": "video", "extractor": info.get("extractor_key") or "", "site": info.get("extractor") or "", "id": str(info.get("id") or ""), "title": str(info.get("title") or "")[:300],
        "uploader": str(info.get("uploader") or info.get("channel") or "")[:120], "duration": number(info.get("duration")), "thumbnail": thumbnail,
        "webpage_url": info.get("webpage_url") or "", "live": bool(info.get("is_live")), "liveStatus": info.get("live_status") or "", "drm": drm,
        "qualities": qualities[:14], "audio": audio, "formatCount": len(info.get("formats") or []), "ext": info.get("ext") or "",
        "subtitles": sorted(set(list((info.get("subtitles") or {}).keys())))[:12],
        "single": None if qualities else {"ext": info.get("ext") or "", "size": int(info.get("filesize") or info.get("filesize_approx") or 0), "height": int(info.get("height") or 0), "width": int(info.get("width") or 0)},
    }


def probe_args(message, cookie_file, impersonate=False):
    url = validate_url(message.get("url"))
    args = [str(tool("yt-dlp")), "--ignore-config", "--dump-single-json", "--no-warnings", "--no-colors", "--playlist-end", "60", "--flat-playlist", "--socket-timeout", "20",
            "--retries", "2", "--extractor-retries", "1", "--js-runtimes", "deno:" + str(tool("deno")), "--ffmpeg-location", str(tool("ffmpeg").parent)]
    headers = message.get("headers")
    referer = safe_url(pick_header(headers, "referer")) or safe_url(message.get("pageURL"))
    if referer:
        args += ["--referer", referer]
    agent = pick_header(headers, "user-agent")
    if agent:
        args += ["--user-agent", agent]
    origin = pick_header(headers, "origin")
    if origin:
        args += ["--add-header", f"Origin:{origin}"]
    for name, value in clean_headers(headers).items():
        args += ["--add-header", f"{name}:{value}"]
    if impersonate:
        args += ["--impersonate", "chrome"]
    if cookie_file:
        args += ["--cookies", cookie_file]
    return args + ["--", url]


def probe(message):
    url = validate_url(message.get("url"))
    key = (url, bool(message.get("pageURL")))
    with PROBES_LOCK:
        pending = PROBES.get(key)
        if pending is None:
            pending = concurrent.futures.Future()
            PROBES[key] = pending
            owner = True
        else:
            owner = False
    if not owner:
        return pending.result(timeout=120)
    cookie_file = None
    try:
        cookie_file = write_cookies(message.get("cookies"), [url, message.get("pageURL") or url])
        last_error = ""
        for impersonate in ((False, True) if (CONFIG.get("impersonate") and TOOL_STATE.get("impersonate")) else (False,)):
            with PROBE_SLOTS:
                result = subprocess.run(probe_args(message, cookie_file, impersonate), capture_output=True, timeout=90, creationflags=CREATE_NO_WINDOW, stdin=subprocess.DEVNULL, env=dict(os.environ, PYTHONIOENCODING="utf-8", PYTHONUTF8="1"))
            stdout = result.stdout.decode("utf-8", "replace").strip()
            stderr = result.stderr.decode("utf-8", "replace")
            if result.returncode == 0 and stdout:
                info = normalize_info(json.loads(stdout))
                pending.set_result({"ok": True, "info": info})
                return {"ok": True, "info": info}
            lines = [line for line in stderr.splitlines() if line.startswith("ERROR")]
            last_error = (lines[-1] if lines else stderr.strip()[-400:] or "Nothing to download here.")[:500]
            if classify_error(last_error) in TERMINAL_CODES | {"unsupported", "gone"}:
                break
        response = {"ok": False, "error": last_error, "errorCode": classify_error(last_error)}
        pending.set_result(response)
        return response
    except Exception as error:
        response = {"ok": False, "error": str(error)[:500], "errorCode": "unknown"}
        pending.set_result(response)
        return response
    finally:
        if cookie_file:
            Path(cookie_file).unlink(missing_ok=True)
        with PROBES_LOCK:
            PROBES.pop(key, None)


def media_info(message):
    url = validate_url(message.get("url"))
    cookies = cookie_header(message.get("cookies"), url) if message.get("cookies") else ""
    with PROBE_SLOTS:
        data = run_ffprobe(url, message.get("headers") or {}, cookies, timeout=45, kind=str(message.get("kind") or ""))
    return {"ok": True, "info": summarize_ffprobe(data)}


# -------------------------------------------------------------- job runner ---
def new_job(message):
    job_id = message.get("id", "")
    if not isinstance(job_id, str) or not re.fullmatch(r"[a-zA-Z0-9-]{1,80}", job_id):
        raise ValueError("Invalid download ID.")
    url = validate_url(message.get("url"))
    page = message.get("pageURL")
    if page:
        validate_url(page)
    folder = downloads_folder()
    ensure_folder(folder)
    (folder / PARTIAL_DIR).mkdir(exist_ok=True)
    if os.name == "nt":
        try:
            ctypes.windll.kernel32.SetFileAttributesW(str(folder / PARTIAL_DIR), 0x2)  # hidden
        except Exception:
            pass
    resume_stem = message.get("stem")
    stem = None
    if message.get("resume") and isinstance(resume_stem, str) and safe_stem(resume_stem, 400) == resume_stem:
        with SCHED_LOCK:
            if resume_stem.lower() not in TAKEN_STEMS:
                TAKEN_STEMS.add(resume_stem.lower())
                stem = resume_stem
    if stem is None:
        stem = reserve_stem(folder, safe_stem(message.get("filename") or message.get("title"), stem_limit(folder)))
    live = bool(message.get("live"))
    expected = int(number(message.get("expectedSize")))
    if expected > 0:
        try:
            free = shutil.disk_usage(folder).free
            if free < expected * 1.1 + 50 * 1024 * 1024:
                raise OSError("Not enough free disk space for this video (%.1f GB needed, %.1f GB free)." % (expected / 1024 ** 3, free / 1024 ** 3))
        except OSError as error:
            if "Not enough free" in str(error):
                raise
    job = {
        "msg": message, "folder": folder, "stem": stem, "url": url, "cancel": threading.Event(), "cancel_mode": "cancel", "process": None, "running": False,
        "headers": clean_headers(message.get("headers")), "cookie_file": None, "live": live,
        "public": {"id": job_id, "state": "queued", "progress": 0, "stem": stem, "title": str(message.get("title") or "")[:240], "detail": "Waiting in queue…", "live": live},
    }
    return job


def emit(job, **update):
    with SCHED_LOCK:
        job["public"].update(update)
        snapshot = dict(job["public"])
    send({"event": "job", "job": snapshot})


def schedule():
    with SCHED_LOCK:
        if UPDATING.is_set() or STOPPING.is_set():
            return
        running = sum(1 for item in JOBS.values() if item["running"])
        while QUEUE and running < max(1, min(4, int(CONFIG.get("parallel", 2)))):
            job = QUEUE.popleft()
            if job["cancel"].is_set():
                continue
            job["running"] = True
            running += 1
            threading.Thread(target=run_job, args=(job,), daemon=True).start()


def stop_process(process):
    if process is None or process.poll() is not None:
        return
    if os.name == "nt":
        try:
            subprocess.run(["taskkill.exe", "/PID", str(process.pid), "/T", "/F"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, creationflags=CREATE_NO_WINDOW, timeout=15)
        except (OSError, subprocess.SubprocessError):
            process.kill()
    else:
        process.terminate()


class Progress:
    """Turns per-stream yt-dlp progress into one steady 0-100 number."""

    def __init__(self):
        self.streams = 1
        self.index = -1

    def weights(self):
        if self.streams == 2:
            return [0.88, 0.12]
        return [1 / max(1, self.streams)] * max(1, self.streams)

    def overall(self, current):
        weights = self.weights()
        index = min(max(self.index, 0), len(weights) - 1)
        done = sum(weights[:index])
        return min(99.0, (done + weights[index] * max(0.0, min(100.0, current)) / 100) * 100)


FRAGMENT_ERROR = re.compile(r"Got error: .*?HTTP Error (404|410|403|401)", re.I)


def drain(job, process, state):
    progress = Progress()
    seen = 0          # bytes of the current stream, for "is it still making progress?"
    strikes = {"count": 0, "mark": -1}
    for raw in process.stdout:
        line = raw.strip()
        if not line:
            continue
        state["tail"].append(line[:400])
        if m := FRAGMENT_ERROR.search(line):
            # yt-dlp politely retries dead fragments for minutes. A repeated 404/403 with no
            # progress in between will not heal, so stop and let the retry ladder try another way.
            strikes["count"] = strikes["count"] + 1 if seen <= strikes["mark"] else 1
            strikes["mark"] = seen
            if strikes["count"] >= (3 if m.group(1) in ("404", "410") else 4):
                state["errors"].append(f"HTTP Error {m.group(1)}: the server keeps refusing this stream")
                stop_process(process)
                break
        if line.startswith("QVS_PROGRESS:"):
            try:
                data = json.loads(line[len("QVS_PROGRESS:"):])
            except ValueError:
                continue
            state["seen_at"] = time.monotonic()
            total = number(data.get("t")) or number(data.get("e"))
            downloaded = number(data.get("d"))
            seen = max(seen, downloaded)
            if total:
                percent = min(100.0, downloaded * 100 / total)
            elif number(data.get("fc")):
                percent = min(100.0, number(data.get("fi")) * 100 / number(data.get("fc")))
            else:
                percent = 0.0
            emit(job, state="downloading", progress=round(progress.overall(percent), 1), downloaded=int(downloaded), total=int(total), speed=int(number(data.get("s"))), eta=int(number(data.get("r"))),
                 detail="Downloading audio…" if progress.streams == 2 and progress.index == 1 else "Downloading…")
        elif line.startswith("QVS_TITLE:"):
            try:
                state["title"] = str(json.loads(line[len("QVS_TITLE:"):]))[:240]
            except ValueError:
                pass
        elif line.startswith("QVS_FILE:"):
            try:
                state["file"] = Path(json.loads(line[len("QVS_FILE:"):]))
            except (ValueError, TypeError):
                pass
        elif line.startswith("[download] Destination:") or "has already been downloaded" in line:
            progress.index += 1
        elif m := re.search(r"Downloading (\d+) format\(s\)", line):
            progress.streams = max(1, int(m.group(1)))
        elif "Resuming download" in line:
            emit(job, detail="Resuming where it stopped…")
        elif re.match(r"\[(Merger|VideoRemuxer|ExtractAudio|Fixup|FixupM3u8|FixupM4a|MoveFiles|Metadata)", line):
            emit(job, state="processing", detail="Merging audio & video…" if "Merger" in line else "Finishing file…", progress=99.0, speed=0, eta=0)
        elif line.startswith("[hlsnative] Downloading m3u8") or line.startswith("[generic]") or line.startswith("[info]"):
            emit(job, detail="Analyzing stream…")
        elif line.startswith("ERROR:") and line[6:].strip():
            state["errors"].append(line[6:].strip()[:800])


def watch_partial(job, state, stop):
    """Some downloaders (FFmpeg for live streams) print no progress: report what is growing on disk instead."""
    tmp = job["folder"] / PARTIAL_DIR
    prefix = job["stem"].lower() + "."
    previous, moment = 0, time.monotonic()
    while not stop.wait(1.0):
        if time.monotonic() - state.get("seen_at", 0) < 3.5:
            continue
        size = 0
        try:
            with os.scandir(tmp) as entries:
                # os.stat on the path: DirEntry.stat() reports a stale size for files another process is writing.
                size = sum(os.stat(entry.path).st_size for entry in entries if entry.name.lower().startswith(prefix))
        except OSError:
            continue
        if size <= 0:
            continue
        now = time.monotonic()
        speed = int(max(0, size - previous) / max(0.5, now - moment))
        previous, moment = size, now
        emit(job, state="downloading", downloaded=size, speed=speed, detail="Recording the live stream…" if job["live"] else "Downloading…")


def attempt_ytdlp(job, attempt, target_url):
    state = {"tail": collections.deque(maxlen=40), "errors": [], "file": None, "title": "", "seen_at": 0}
    args = build_ytdlp(job, attempt, target_url)
    env = dict(os.environ, PYTHONIOENCODING="utf-8", PYTHONUTF8="1")
    process = subprocess.Popen(args, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL, encoding="utf-8", errors="replace", creationflags=CREATE_NO_WINDOW, env=env)
    with SCHED_LOCK:
        job["process"] = process
    if job["cancel"].is_set():
        stop_process(process)
    stop_watch = threading.Event()
    threading.Thread(target=watch_partial, args=(job, state, stop_watch), daemon=True).start()
    try:
        drain(job, process, state)
        code = process.wait()
    finally:
        stop_watch.set()
        if process.poll() is None:
            stop_process(process)
        if process.stdout:
            process.stdout.close()
    return {"code": code, "file": state["file"], "title": state["title"], "error": state["errors"][-1] if state["errors"] else "", "tail": list(state["tail"])}


def ffmpeg_command(job, source, output, mkv=False):
    msg = job["msg"]
    headers = job["headers"]
    lines = []
    referer = pick_header(msg.get("headers"), "referer") or msg.get("pageURL") or ""
    if referer:
        lines.append(f"Referer: {referer}")
    origin = pick_header(msg.get("headers"), "origin")
    if origin:
        lines.append(f"Origin: {origin}")
    lines += [f"{k}: {v}" for k, v in headers.items()]
    cookies = cookie_header(job.get("cookies"), source) if job.get("cookies") else ""
    if cookies:
        lines.append(f"Cookie: {cookies}")
    args = [str(tool("ffmpeg")), "-hide_banner", "-nostdin", "-loglevel", "error", "-progress", "pipe:1", "-nostats", "-y"]
    agent = pick_header(msg.get("headers"), "user-agent")
    if agent:
        args += ["-user_agent", agent]
    if lines:
        args += ["-headers", "".join(line + "\r\n" for line in lines)]
    args += ["-rw_timeout", "30000000", "-reconnect", "1", "-reconnect_streamed", "1", "-reconnect_delay_max", "8"]
    if is_hls(source, msg.get("kind", "")):
        args += HLS_INPUT_OPTIONS
    args += ["-i", source]
    # Default stream selection picks the best video and audio of a master playlist.
    args += ["-sn", "-dn", "-c", "copy"]
    if not mkv:
        args += ["-movflags", "+faststart"]
    return args + [str(output)]


MUX_ERROR = re.compile(r"Could not write header|not currently supported in container|Invalid argument|Unsupported codec|Error initializing output stream|Tag .* incompatible", re.I)


def attempt_ffmpeg(job, source, duration):
    """Last resort: let FFmpeg copy the stream straight from the URL."""
    folder = job["folder"]
    tail = collections.deque(maxlen=40)
    for mkv in (False, True):
        suffix = ".mkv" if mkv else ".mp4"
        out = folder / PARTIAL_DIR / (job["stem"] + ".ffmpeg" + suffix)
        out.unlink(missing_ok=True)
        process = subprocess.Popen(ffmpeg_command(job, source, out, mkv), stdout=subprocess.PIPE, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL, encoding="utf-8", errors="replace", creationflags=CREATE_NO_WINDOW)
        with SCHED_LOCK:
            job["process"] = process
        if job["cancel"].is_set():
            stop_process(process)
        started = time.monotonic()
        try:
            for raw in process.stdout:
                line = raw.strip()
                tail.append(line[:300])
                if line.startswith(("out_time_us=", "out_time_ms=")):
                    done = number(line.split("=", 1)[1]) / 1_000_000
                    elapsed = max(0.1, time.monotonic() - started)
                    emit(job, state="downloading", detail="Downloading (direct stream copy)…", progress=round(min(99.0, done * 100 / duration), 1) if duration else 0,
                         eta=int((duration - done) / (done / elapsed)) if duration and done > 1 else 0)
                elif line.startswith("total_size="):
                    emit(job, downloaded=int(number(line.split("=", 1)[1])))
            code = process.wait()
        finally:
            if process.poll() is None:
                stop_process(process)
            process.stdout.close()
        if job["cancel"].is_set():
            out.unlink(missing_ok=True)
            return {"code": 1, "file": None, "error": "Cancelled", "tail": list(tail)}
        if code == 0 and out.is_file() and out.stat().st_size > 0:
            final = unique_final(folder, job["stem"], suffix)
            shutil.move(str(out), str(final))
            return {"code": 0, "file": final, "error": "", "tail": list(tail)}
        out.unlink(missing_ok=True)
        if not MUX_ERROR.search("\n".join(tail)):
            break
    return {"code": 1, "file": None, "error": next((line for line in reversed(tail) if line), "ffmpeg failed"), "tail": list(tail)}


def unique_final(folder, stem, suffix):
    path = folder / (stem + suffix)
    n = 2
    while path.exists():
        path = folder / f"{stem} ({n}){suffix}"
        n += 1
    return path


def cleanup_partials(job):
    tmp = job["folder"] / PARTIAL_DIR
    stem = job["stem"].lower()
    # Windows may still hold a lock for a moment after the process tree was killed: retry briefly.
    for attempt in range(6):
        leftovers = 0
        try:
            with os.scandir(tmp) as entries:
                for entry in list(entries):
                    if entry.name.lower().startswith(stem + "."):
                        try:
                            os.remove(entry.path)
                        except OSError:
                            leftovers += 1
        except OSError:
            return
        if not leftovers:
            return
        time.sleep(0.25)


def save_live_partial(job):
    """Stopping a live recording keeps what was captured so far (playable .ts, remuxed to .mp4 when possible)."""
    tmp = job["folder"] / PARTIAL_DIR
    stem = job["stem"].lower()
    best = None
    try:
        with os.scandir(tmp) as entries:
            for entry in entries:
                name = entry.name.lower()
                if name.startswith(stem + ".") and name.endswith(".part"):
                    size = os.stat(entry.path).st_size
                    if size > 0 and (best is None or size > best[0]):
                        best = (size, Path(entry.path))
    except OSError:
        return None
    if not best:
        return None
    # --hls-use-mpegts keeps the capture playable while it grows, whatever the target extension says.
    captured = unique_final(job["folder"], job["stem"], ".ts")
    for attempt in range(12):  # the killed downloader may still hold the file for a moment
        try:
            shutil.move(str(best[1]), str(captured))
            break
        except OSError:
            if attempt == 11:
                raise
            time.sleep(0.4)
    remuxed = unique_final(job["folder"], job["stem"], ".mp4")
    try:
        result = run_quiet([str(tool("ffmpeg")), "-hide_banner", "-nostdin", "-loglevel", "error", "-y", "-i", str(captured), "-c", "copy", "-movflags", "+faststart", str(remuxed)], 600)
        if result.returncode == 0 and remuxed.is_file() and remuxed.stat().st_size > 0 and verify_media(remuxed)[0]:
            captured.unlink(missing_ok=True)
            return remuxed
    except (OSError, subprocess.SubprocessError):
        pass
    remuxed.unlink(missing_ok=True)
    return captured


def plan_attempts(msg):
    kind = msg.get("kind") or "file"
    url = msg["url"]
    page = msg.get("pageURL") or ""
    strategy = msg.get("strategy") or "auto"
    if strategy == "ffmpeg":
        return [{"tool": "ffmpeg", "label": "direct stream copy", "url": url}]
    attempts = []
    if kind == "page":
        attempts.append({"tool": "ytdlp", "label": "site extractor", "url": url, "level": "page"})
        if CONFIG.get("impersonate") and TOOL_STATE.get("impersonate"):
            attempts.append({"tool": "ytdlp", "label": "browser identity", "url": url, "level": "page", "impersonate": True})
        return attempts
    attempts.append({"tool": "ytdlp", "label": "standard download", "url": url})
    if CONFIG.get("impersonate") and TOOL_STATE.get("impersonate"):
        attempts.append({"tool": "ytdlp", "label": "browser identity", "url": url, "impersonate": True})
    if page and page != url and msg.get("allowPage", True):
        attempts.append({"tool": "ytdlp", "label": "page extractor", "url": page, "level": "page"})
    if kind in ("hls", "dash", "file", "mss", "audio") and not (msg.get("format") or {}).get("audioOnly"):
        attempts.append({"tool": "ffmpeg", "label": "direct stream copy", "url": url})
    return attempts


def finish_file(job, path):
    """Validate the result and publish the completed state."""
    path = Path(path)
    if not path.is_file():
        return False, "not_media", "The downloader reported success but no file was written."
    ok, info = verify_media(path)
    if not ok:
        reason = "The server sent a web page or damaged data instead of a video. The link may have expired or need a login."
        try:
            path.unlink()
        except OSError:
            pass
        return False, "not_media", reason
    KNOWN_FILES.add(str(path.resolve()).lower())
    emit(job, state="complete", progress=100, detail="Saved", filename=path.name, path=str(path), size=path.stat().st_size, speed=0, eta=0, error="", errorCode="",
         media={k: info.get(k) for k in ("width", "height", "duration", "vcodec", "acodec", "container") if info.get(k)})
    return True, "", ""


def run_job(job):
    msg = job["msg"]
    public = job["public"]
    try:
        if not ready():
            raise RuntimeError("tool_missing")
        job["cookies"] = msg.get("cookies") if isinstance(msg.get("cookies"), list) else []
        urls = [u for u in (msg["url"], msg.get("pageURL")) if u]
        job["cookie_file"] = write_cookies(job["cookies"], urls)
        msg.pop("cookies", None)
        emit(job, state="starting", detail="Preparing download…", progress=0)
        attempts = plan_attempts(msg)
        errors = []
        total = len(attempts)
        index = 0
        while index < total:
            attempt = attempts[index]
            if job["cancel"].is_set():
                break
            if index:
                emit(job, detail=f"Retrying with {attempt['label']} ({index + 1}/{total})…", progress=0, speed=0, eta=0)
            emit(job, attempt=index + 1, attempts=total, strategy=attempt["label"])
            result = attempt_ffmpeg(job, attempt["url"], number(msg.get("duration"))) if attempt["tool"] == "ffmpeg" else attempt_ytdlp(job, attempt, attempt["url"])
            if job["cancel"].is_set():
                break
            if result["code"] == 0 and result["file"]:
                ok, code, reason = finish_file(job, result["file"])
                if ok:
                    return
                errors.append((code, reason, result["tail"]))
            else:
                raw = result["error"] or ("\n".join(result["tail"][-6:]) or "The download failed.")
                code = classify_error(raw if raw != "Cancelled" else "")
                if attempt["tool"] == "ytdlp" and code == "postprocess" and not attempt.get("noremux"):
                    attempts.insert(index + 1, {**attempt, "noremux": True, "label": "alternate container"})
                    total += 1
                errors.append((code, raw[:800], result["tail"]))
            if errors[-1][0] in TERMINAL_CODES:
                break
            if errors[-1][0] == "gone":
                # An expired or removed file URL: only a fresh extraction from the page can help.
                later = next((i for i in range(index + 1, total) if attempts[i].get("level") == "page"), None)
                if later is None:
                    break
                index = later
                continue
            index += 1
        if job["cancel"].is_set():
            mode = job["cancel_mode"]
            if mode == "stop" and job["live"]:
                try:
                    saved = save_live_partial(job)
                except OSError as error:
                    saved = None
                    emit(job, detail="Could not save the recording: " + str(error)[:120])
                if saved:
                    KNOWN_FILES.add(str(saved.resolve()).lower())
                    emit(job, state="complete", progress=100, detail="Stopped. The recording so far was saved.", filename=saved.name, path=str(saved), size=saved.stat().st_size, speed=0, eta=0)
                    return
            if mode == "pause":
                emit(job, state="paused", detail="Paused. Resume to continue where it stopped.", speed=0, eta=0)
            else:
                cleanup_partials(job)
                emit(job, state="cancelled", detail="Cancelled", speed=0, eta=0)
            return
        # Prefer the first meaningful error: later attempts usually fail for derived reasons.
        meaningful = next((e for e in errors if e[0] not in ("unsupported", "unknown")), errors[0] if errors else ("unknown", "The download failed.", []))
        diag = "\n".join(meaningful[2][-14:])[:3000]
        emit(job, state="error", error=meaningful[1], errorCode=meaningful[0], diag=diag, speed=0, eta=0, detail="Failed")
    except Exception as error:
        text = str(error)[:800]
        if job["cancel"].is_set():
            emit(job, state="paused" if job["cancel_mode"] == "pause" else "cancelled", detail="Cancelled", speed=0, eta=0)
        else:
            emit(job, state="error", error=text, errorCode="tool_missing" if text == "tool_missing" else classify_error(text), detail="Failed", speed=0, eta=0)
    finally:
        process = job.get("process")
        if process is not None and process.poll() is None:
            stop_process(process)
        if job.get("cookie_file"):
            Path(job["cookie_file"]).unlink(missing_ok=True)
        msg.pop("cookies", None)
        job.pop("cookies", None)
        with SCHED_LOCK:
            job["running"] = False
            JOBS.pop(job["public"]["id"], None)
            # Paused partials stay protected by stem_exists(); the stem itself is free for a resume.
            TAKEN_STEMS.discard(job["stem"].lower())
        schedule()


# --------------------------------------------------------------- housekeeping
def allowed_path(value):
    try:
        path = Path(str(value)).resolve()
    except (OSError, ValueError):
        raise ValueError("Invalid file path.")
    if path.suffix.lower() not in MEDIA_EXTS or not path.is_file():
        raise ValueError("That file no longer exists.")
    inside = False
    try:
        path.relative_to(downloads_folder().resolve())
        inside = True
    except (ValueError, OSError):
        pass
    if not inside and str(path).lower() not in KNOWN_FILES:
        raise ValueError("That file is outside the download folder.")
    return path


def choose_folder(start):
    script = (
        "[Console]::OutputEncoding=[Text.Encoding]::UTF8;Add-Type -AssemblyName System.Windows.Forms;"
        "$f=New-Object System.Windows.Forms.FolderBrowserDialog;$f.Description='Choose where Quick Video Saver stores videos';"
        "$f.ShowNewFolderButton=$true;if($env:QVS_START -and (Test-Path -LiteralPath $env:QVS_START)){$f.SelectedPath=$env:QVS_START};"
        "$o=New-Object System.Windows.Forms.Form;$o.TopMost=$true;$o.ShowInTaskbar=$false;$o.Opacity=0;$o.StartPosition='CenterScreen';$o.Show();"
        "if($f.ShowDialog($o) -eq 'OK'){[Console]::Out.Write($f.SelectedPath)};$o.Close()"
    )
    encoded = base64.b64encode(script.encode("utf-16-le")).decode()
    env = dict(os.environ, QVS_START=str(start))
    result = subprocess.run(["powershell.exe", "-NoLogo", "-NoProfile", "-STA", "-NonInteractive", "-EncodedCommand", encoded], capture_output=True, timeout=600, creationflags=CREATE_NO_WINDOW, env=env, stdin=subprocess.DEVNULL)
    return result.stdout.decode("utf-8", "replace").strip()


def update_tools(force=False):
    """Update yt-dlp in place (it verifies the release checksum itself)."""
    with SCHED_LOCK:
        if any(item["running"] for item in JOBS.values()):
            return {"ok": False, "error": "Finish or pause active downloads, then update."}
        UPDATING.set()
    try:
        before = TOOL_STATE.get("ytdlp") or ""
        result = subprocess.run([str(tool("yt-dlp")), "--update-to", "stable"], capture_output=True, timeout=240, creationflags=CREATE_NO_WINDOW, stdin=subprocess.DEVNULL, env=dict(os.environ, PYTHONIOENCODING="utf-8", PYTHONUTF8="1"))
        output = (result.stdout + result.stderr).decode("utf-8", "replace")
        TOOL_STATE["ytdlp"] = None
        TOOL_STATE["updated"] = time.time()
        after = tool_versions(fetch=True)["ytdlp"]
        _save_state()
        if result.returncode != 0 and not after:
            return {"ok": False, "error": output.strip().splitlines()[-1][:300] if output.strip() else "Update failed."}
        return {"ok": True, "updated": bool(before and after and before != after), "version": after, "previous": before}
    except Exception as error:
        TOOL_STATE["ytdlp"] = None
        return {"ok": False, "error": str(error)[:300]}
    finally:
        UPDATING.clear()
        schedule()


STATE_FILE = RUNTIME / "qvs-state.json"


def _load_state():
    try:
        TOOL_STATE["updated"] = float(json.loads(STATE_FILE.read_text(encoding="utf-8")).get("updated", 0))
    except Exception:
        pass


def _save_state():
    try:
        STATE_FILE.write_text(json.dumps({"updated": TOOL_STATE["updated"]}), encoding="utf-8")
    except OSError:
        pass


def maybe_auto_update():
    time.sleep(45)
    if STOPPING.is_set() or not CONFIG.get("autoUpdate") or time.time() - TOOL_STATE["updated"] < 3 * 24 * 3600:
        return
    result = update_tools()
    send({"event": "tools", **public_tools(), "updateResult": result})


def apply_config(values):
    if not isinstance(values, dict):
        return
    if "folder" in values:
        folder = str(values["folder"] or "").strip()
        if folder:
            path = Path(folder)
            if not path.is_absolute():
                raise ValueError("Pick a full folder path, for example C:\\Videos.")
            ensure_folder(path)
        CONFIG["folder"] = folder
    if "parallel" in values:
        CONFIG["parallel"] = max(1, min(4, int(values["parallel"])))
    if values.get("container") in ("mp4", "mkv"):
        CONFIG["container"] = values["container"]
    if values.get("audioFormat") in ("mp3", "m4a"):
        CONFIG["audioFormat"] = values["audioFormat"]
    for key in ("preferCompat", "subtitles", "autoUpdate", "impersonate"):
        if key in values:
            CONFIG[key] = bool(values[key])
    if "fragments" in values:
        CONFIG["fragments"] = max(1, min(16, int(values["fragments"])))
    schedule()


def reply(request_id, **payload):
    send({"ok": True, "requestId": request_id, **payload})


def run_async(request_id, function):
    def runner():
        try:
            reply(request_id, **function())
        except Exception as error:
            send({"ok": False, "requestId": request_id, "error": str(error)[:500]})
    POOL.submit(runner)


def handle(message):
    request_id = message.get("requestId")
    try:
        action = message.get("type")
        if action == "ping":
            config_error = ""
            if "config" in message:
                try:
                    apply_config(message["config"])
                except (ValueError, OSError, TypeError) as error:
                    config_error = str(error)[:300]
            reply(request_id, version=VERSION, folder=str(downloads_folder()), configError=config_error, **public_tools())
        elif action == "configure":
            apply_config(message.get("config"))
            reply(request_id, folder=str(downloads_folder()))
        elif action == "start":
            if not ready():
                raise RuntimeError("The helper tools are missing. Run SETUP-WINDOWS.cmd again.")
            job = new_job(message)
            job_id = job["public"]["id"]
            with SCHED_LOCK:
                if job_id in JOBS:
                    release_stem(job["stem"])
                    raise ValueError("This download is already queued.")
                duplicate = next((j for j in JOBS.values() if j["url"] == job["url"] and (j["msg"].get("format") or {}) == (message.get("format") or {})), None)
                if duplicate is not None:
                    release_stem(job["stem"])
                    raise ValueError("This video and quality is already downloading.")
                JOBS[job_id] = job
                QUEUE.append(job)
            reply(request_id, stem=job["stem"], folder=str(job["folder"]))
            emit(job)
            schedule()
        elif action == "cancel":
            with SCHED_LOCK:
                job = JOBS.get(message.get("id"))
            if job:
                mode = message.get("mode") if message.get("mode") in ("cancel", "pause", "stop") else "cancel"
                job["cancel_mode"] = mode
                job["cancel"].set()
                stop_process(job.get("process"))
                with SCHED_LOCK:
                    queued = job in QUEUE
                    if queued:
                        QUEUE.remove(job)
                if queued:
                    emit(job, state="paused" if mode == "pause" else "cancelled", detail="Paused" if mode == "pause" else "Cancelled")
                    with SCHED_LOCK:
                        JOBS.pop(job["public"]["id"], None)
                        if mode != "pause":
                            release_stem(job["stem"])
            reply(request_id)
        elif action == "discard":
            stem = message.get("stem")
            if not isinstance(stem, str) or safe_stem(stem, 400) != stem:
                raise ValueError("Invalid file name.")
            with SCHED_LOCK:
                if stem.lower() in TAKEN_STEMS:
                    raise ValueError("That download is still active.")
            cleanup_partials({"folder": downloads_folder(), "stem": stem})
            reply(request_id)
        elif action == "probe":
            run_async(request_id, lambda: probe(message))
        elif action == "media_info":
            run_async(request_id, lambda: media_info(message))
        elif action == "folder":
            folder = downloads_folder()
            ensure_folder(folder)
            os.startfile(folder)
            reply(request_id)
        elif action == "reveal":
            path = allowed_path(message.get("path"))
            subprocess.Popen(["explorer.exe", "/select," + str(path)], creationflags=CREATE_NO_WINDOW)
            reply(request_id)
        elif action == "open":
            os.startfile(allowed_path(message.get("path")))
            reply(request_id)
        elif action == "delete_file":
            path = allowed_path(message.get("path"))
            path.unlink()
            KNOWN_FILES.discard(str(path).lower())
            reply(request_id)
        elif action == "exists":
            paths = [p for p in (message.get("paths") or [])[:200] if isinstance(p, str)]
            reply(request_id, exists={p: os.path.isfile(p) for p in paths})
        elif action == "choose_folder":
            run_async(request_id, lambda: {"folder": choose_folder(message.get("start") or downloads_folder())})
        elif action == "update":
            run_async(request_id, lambda: update_tools(True))
        else:
            raise ValueError("Unknown helper action.")
    except Exception as error:
        send({"ok": False, "requestId": request_id, "error": str(error)[:800]})


def expected_origin():
    manifest = json.loads((ROOT.parent / "extension" / "manifest.json").read_text(encoding="utf-8"))
    digest = hashlib.sha256(base64.b64decode(manifest["key"])).hexdigest()[:32]
    return f"chrome-extension://{''.join(chr(97 + int(char, 16)) for char in digest)}/"


def main():
    if os.name == "nt":
        import msvcrt
        msvcrt.setmode(sys.stdin.fileno(), os.O_BINARY)
        msvcrt.setmode(sys.stdout.fileno(), os.O_BINARY)
    if "--check" in sys.argv:
        print(json.dumps({"ready": ready(), "folder": str(downloads_folder()), "version": VERSION}))
        POOL.shutdown()
        return
    if len(sys.argv) < 2 or sys.argv[1] != expected_origin():
        raise SystemExit("This helper is started by the Quick Video Saver extension.")
    _load_state()
    threading.Thread(target=detect_tools, daemon=True).start()
    threading.Thread(target=maybe_auto_update, daemon=True).start()
    try:
        while not STOPPING.is_set():
            message = read_message(sys.stdin.buffer)
            if message is None:
                break
            handle(message)
    except (ValueError, OSError):
        pass
    finally:
        STOPPING.set()
        with SCHED_LOCK:
            jobs = list(JOBS.values())
        for job in jobs:
            job["cancel_mode"] = "pause"
            job["cancel"].set()
            try:
                stop_process(job.get("process"))
            except (OSError, subprocess.SubprocessError):
                pass
        POOL.shutdown(wait=True, cancel_futures=True)
        deadline = time.monotonic() + 8
        while any(job["running"] for job in jobs) and time.monotonic() < deadline:
            time.sleep(0.1)


if __name__ == "__main__":
    main()

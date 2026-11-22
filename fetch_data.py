#!/usr/bin/env python3
"""Joker Sports data builder.

Pulls fixtures for the coming week from free, keyless public sources and
writes data/matches.json. Runs locally and inside GitHub Actions.

Sources:
  - ESPN public scoreboard/summary JSON (site.api.espn.com) - main source.
  - TheSportsDB free test key - best-effort extra for the Egyptian league.

Honesty rules baked in here:
  * Never invent commentator, quality or channel data. Fields the source
    does not provide stay null and the UI says so explicitly.
  * Every match carries its source name, a source URL and a fetched-at
    timestamp so the UI can show freshness.
"""
import json
import sys
import time
import urllib.request
from datetime import datetime, timedelta, timezone

UA = {"User-Agent": "joker-sports/1.0 (+github-pages fixtures viewer)"}
DAYS_AHEAD = 8  # today .. today+7 (UTC)

ESPN_LEAGUES = [
    ("esp.1", "La Liga", "الدوري الإسباني"),
    ("eng.1", "Premier League", "الدوري الإنجليزي الممتاز"),
    ("ita.1", "Serie A", "الدوري الإيطالي"),
    ("ger.1", "Bundesliga", "الدوري الألماني"),
    ("fra.1", "Ligue 1", "الدوري الفرنسي"),
    ("uefa.champions", "UEFA Champions League", "دوري أبطال أوروبا"),
]

# Arabic display names for well-known clubs. Unknown clubs keep their
# source (Latin) name - we never translate by guessing.
TEAM_AR = {
    "Real Madrid": "ريال مدريد", "Barcelona": "برشلونة", "Atletico Madrid": "أتلتيكو مدريد",
    "Sevilla": "إشبيلية", "Valencia": "فالنسيا", "Villarreal": "فياريال",
    "Real Betis": "ريال بيتيس", "Athletic Club": "أتلتيك بلباو", "Real Sociedad": "ريال سوسيداد",
    "Girona": "جيرونا", "Getafe": "خيتافي", "Osasuna": "أوساسونا", "Celta Vigo": "سيلتا فيجو",
    "Rayo Vallecano": "رايو فاليكانو", "Mallorca": "مايوركا", "Alaves": "ألافيس",
    "Espanyol": "إسبانيول", "Levante": "ليفانتي", "Elche": "إلتشي", "Real Oviedo": "ريال أوفييدو",
    "Arsenal": "أرسنال", "Manchester City": "مانشستر سيتي", "Manchester United": "مانشستر يونايتد",
    "Liverpool": "ليفربول", "Chelsea": "تشيلسي", "Tottenham Hotspur": "توتنهام",
    "Newcastle United": "نيوكاسل يونايتد", "Aston Villa": "أستون فيلا", "West Ham United": "وست هام",
    "Brighton & Hove Albion": "برايتون", "Everton": "إيفرتون", "Fulham": "فولهام",
    "Crystal Palace": "كريستال بالاس", "Brentford": "برينتفورد", "Wolverhampton Wanderers": "ولفرهامبتون",
    "Nottingham Forest": "نوتنغهام فورست", "Bournemouth": "بورنموث", "Leeds United": "ليدز يونايتد",
    "Burnley": "بيرنلي", "Sunderland": "سندرلاند",
    "Inter": "إنتر ميلان", "AC Milan": "ميلان", "Juventus": "يوفنتوس", "Napoli": "نابولي",
    "Roma": "روما", "Lazio": "لاتسيو", "Atalanta": "أتالانتا", "Fiorentina": "فيورنتينا",
    "Bayern Munich": "بايرن ميونخ", "Borussia Dortmund": "بوروسيا دورتموند",
    "Bayer Leverkusen": "باير ليفركوزن", "RB Leipzig": "لايبزيغ", "VfB Stuttgart": "شتوتغارت",
    "Paris Saint-Germain": "باريس سان جيرمان", "Marseille": "مارسيليا", "Monaco": "موناكو",
    "Lyon": "ليون", "Lille": "ليل",
    "Al Ahly": "الأهلي", "Zamalek": "الزمالك", "Pyramids": "بيراميدز",
    "Ajax": "أياكس", "PSV Eindhoven": "آيندهوفن", "Feyenoord": "فينورد",
    "Porto": "بورتو", "Benfica": "بنفيكا", "Sporting CP": "سبورتنغ",
    "Galatasaray": "غلطة سراي", "Fenerbahce": "فنربخشة",
    "Celtic": "سيلتيك", "Rangers": "رينجرز", "Club Brugge": "كلوب بروج",
    "Olympiacos": "أولمبياكوس", "Bodo/Glimt": "بودو/غليمت",
    "Qarabag": "كاراباغ", "Kairat Almaty": "كايرات ألماتي", "Pafos": "بافوس",
    "Slavia Prague": "سلافيا براغ", "Union Saint-Gilloise": "أونيون سان جيلواز",
    "Copenhagen": "كوبنهاغن", "Eintracht Frankfurt": "آينتراخت فرانكفورت",
    "Atalanta BC": "أتالانتا", "Sporting Lisbon": "سبورتنغ",
}

FAVORITE_TEAM_NAMES = {"Real Madrid", "Barcelona"}


def get(url):
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r)


def team_from(comp):
    t = comp.get("team", {})
    name = t.get("displayName") or t.get("name") or ""
    return {
        "name": name,
        "nameAr": TEAM_AR.get(name),
        "abbr": t.get("abbreviation"),
        "logo": t.get("logo"),
        "score": comp.get("score"),
        "winner": comp.get("winner"),
        "favorite": name in FAVORITE_TEAM_NAMES,
    }


def broadcasts_from(comp):
    out, seen = [], set()
    for gb in comp.get("geoBroadcasts", []) or []:
        media = (gb.get("media") or {}).get("shortName")
        if not media:
            continue
        typ = ((gb.get("type") or {}).get("shortName")) or ""
        region = gb.get("region") or ""
        key = (media, typ, region)
        if key in seen:
            continue
        seen.add(key)
        out.append({"media": media, "type": typ, "region": region,
                    "lang": gb.get("lang") or ""})
    if not out:
        for b in comp.get("broadcasts", []) or []:
            for nm in b.get("names", []) or []:
                if nm and nm not in seen:
                    seen.add(nm)
                    out.append({"media": nm, "type": "", "region": "", "lang": ""})
    return out


def lineups_for(slug, event_id):
    """Return formation lineups when ESPN has published them, else None."""
    try:
        d = get(f"https://site.api.espn.com/apis/site/v2/sports/soccer/{slug}/summary?event={event_id}")
    except Exception:
        return None
    rosters = d.get("rosters")
    if not rosters:
        return None
    lineups = {}
    found = False
    for side in rosters:
        ha = side.get("homeAway")
        players = []
        for entry in side.get("roster", []) or []:
            ath = entry.get("athlete", {}) or {}
            nm = ath.get("displayName")
            if not nm:
                continue
            players.append({
                "name": nm,
                "position": (entry.get("position") or {}).get("abbreviation"),
                "starter": bool(entry.get("starter", True)),
                "shirt": entry.get("jersey"),
            })
        if players:
            found = True
        lineups[ha] = players
    if not found:
        return None
    return lineups


def fetch_espn(now):
    matches = []
    errors = []
    dates = [(now + timedelta(days=i)).strftime("%Y%m%d") for i in range(DAYS_AHEAD)]
    for slug, name_en, name_ar in ESPN_LEAGUES:
        seen_ids = set()
        for ds in dates:
            url = f"https://site.api.espn.com/apis/site/v2/sports/soccer/{slug}/scoreboard?dates={ds}&limit=200"
            try:
                d = get(url)
            except Exception as e:
                errors.append(f"{slug} {ds}: {e}")
                continue
            for ev in d.get("events", []) or []:
                if ev["id"] in seen_ids:
                    continue
                seen_ids.add(ev["id"])
                comp = (ev.get("competitions") or [{}])[0]
                comps = comp.get("competitors") or []
                home = next((c for c in comps if c.get("homeAway") == "home"), None)
                away = next((c for c in comps if c.get("homeAway") == "away"), None)
                if not home or not away:
                    continue
                st = comp.get("status", {}).get("type", {})
                kickoff = ev.get("date")
                lineups = None
                try:
                    kick_dt = datetime.fromisoformat(kickoff.replace("Z", "+00:00"))
                    if kick_dt - now < timedelta(hours=48):
                        lineups = lineups_for(slug, ev["id"])
                except Exception:
                    pass
                matches.append({
                    "id": f"espn-{ev['id']}",
                    "league": {"slug": slug, "name": name_en, "nameAr": name_ar},
                    "kickoffUtc": kickoff,
                    "status": {
                        "state": st.get("state"),          # pre | in | post
                        "detail": st.get("shortDetail") or st.get("description"),
                        "completed": bool(st.get("completed")),
                    },
                    "home": team_from(home),
                    "away": team_from(away),
                    "venue": (comp.get("venue") or {}).get("fullName"),
                    "broadcasts": broadcasts_from(comp),
                    "broadcastNote": "قنوات السوق الأمريكي كما يعلنها المصدر؛ الناقل في مصر والمنطقة العربية غير متاح من هذا المصدر.",
                    "commentator": None,   # المصدر لا يعلن اسم المعلق
                    "quality": None,       # المصدر لا يعلن جودة البث
                    "lineups": lineups,
                    "source": {"name": "ESPN", "url": url},
                })
            time.sleep(0.15)
    return matches, errors


def fetch_egypt(now):
    """Best-effort Egyptian Premier League via TheSportsDB free test key.
    Data from this source can be partial - flagged as such."""
    out, errors = [], []
    url = "https://www.thesportsdb.com/api/v1/json/123/eventsnextleague.php?id=4829"
    try:
        d = get(url)
    except Exception as e:
        return [], [f"thesportsdb: {e}"]
    horizon = now + timedelta(days=DAYS_AHEAD - 1)
    for ev in d.get("events", []) or []:
        try:
            dt_raw = f"{ev.get('dateEvent','')} {ev.get('strTime') or '00:00:00'}".strip()
            kick = datetime.strptime(dt_raw, "%Y-%m-%d %H:%M:%S").replace(tzinfo=timezone.utc)
        except Exception:
            continue
        if kick < now - timedelta(hours=3) or kick > horizon:
            continue
        home_name = ev.get("strHomeTeam") or ""
        away_name = ev.get("strAwayTeam") or ""
        out.append({
            "id": f"tsdb-{ev.get('idEvent')}",
            "league": {"slug": "egy.1", "name": "Egyptian Premier League",
                       "nameAr": "الدوري المصري الممتاز"},
            "kickoffUtc": kick.strftime("%Y-%m-%dT%H:%M:%SZ"),
            "status": {"state": "pre", "detail": None, "completed": False},
            "home": {"name": home_name, "nameAr": TEAM_AR.get(home_name),
                     "abbr": None, "logo": ev.get("strHomeTeamBadge"),
                     "score": None, "winner": None, "favorite": False},
            "away": {"name": away_name, "nameAr": TEAM_AR.get(away_name),
                     "abbr": None, "logo": ev.get("strAwayTeamBadge"),
                     "score": None, "winner": None, "favorite": False},
            "venue": ev.get("strVenue"),
            "broadcasts": [],
            "broadcastNote": "مصدر مجاني محدود: القنوات والتشكيلات غير متاحة للدوري المصري حاليًا، وقد تكون قائمة المباريات غير مكتملة.",
            "commentator": None,
            "quality": None,
            "lineups": None,
            "source": {"name": "TheSportsDB (free)", "url": url},
            "partialData": True,
        })
    return out, errors


def main():
    now = datetime.now(timezone.utc)
    matches, errors = fetch_espn(now)
    egy, errors2 = fetch_egypt(now)
    matches.extend(egy)
    errors.extend(errors2)
    matches.sort(key=lambda m: m["kickoffUtc"] or "")
    payload = {
        "generatedAtUtc": now.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "windowDays": DAYS_AHEAD,
        "displayTimezone": "Africa/Cairo",
        "leagues": [{"slug": s, "name": n, "nameAr": a} for s, n, a in ESPN_LEAGUES] + [
            {"slug": "egy.1", "name": "Egyptian Premier League", "nameAr": "الدوري المصري الممتاز"}],
        "counts": {"matches": len(matches)},
        "notes": [
            "المعلق وجودة البث لا تعلنهما مصادر البيانات المدمجة (ESPN وTheSportsDB)، فيظهران كـ«غير معلن» بدل التخمين.",
            "القنوات المُعلَّمة 🇺🇸 من بيانات المصدر للسوق الأمريكي؛ الناقل في مصر/المنطقة غير متاح من مصادر البيانات الحالية، ويُراجع في جدول beIN الرسمي.",
            "التشكيلات تُضاف عندما ينشرها المصدر، عادة قرب بداية المباراة.",
        ],
        "errors": errors,
        "matches": matches,
    }
    with open("matches.json", "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=1)
    print(f"wrote {len(matches)} matches; errors: {len(errors)}")
    for e in errors:
        print("ERR:", e, file=sys.stderr)


if __name__ == "__main__":
    main()

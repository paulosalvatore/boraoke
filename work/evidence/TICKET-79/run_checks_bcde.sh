#!/bin/bash
set -u
cd "$(dirname "$0")"
BASE=http://127.0.0.1:3196
OUT=raw_transcripts_bcde.txt
: > "$OUT"
ROOM=some-venue

run() {
  label="$1"; path="$2"; cookie="$3"; al="$4"
  if [ -n "$cookie" ] && [ -n "$al" ]; then
    cmd="curl -s -L -H \"Cookie: NEXT_LOCALE=$cookie\" -H \"Accept-Language: $al\" \"$BASE$path\""
    body=$(curl -s -L -H "Cookie: NEXT_LOCALE=$cookie" -H "Accept-Language: $al" "$BASE$path")
  elif [ -n "$cookie" ]; then
    cmd="curl -s -L -H \"Cookie: NEXT_LOCALE=$cookie\" \"$BASE$path\""
    body=$(curl -s -L -H "Cookie: NEXT_LOCALE=$cookie" "$BASE$path")
  elif [ -n "$al" ]; then
    cmd="curl -s -L -H \"Accept-Language: $al\" \"$BASE$path\""
    body=$(curl -s -L -H "Accept-Language: $al" "$BASE$path")
  else
    cmd="curl -s -L \"$BASE$path\""
    body=$(curl -s -L "$BASE$path")
  fi
  lang=$(printf '%s' "$body" | grep -oE '<html[^>]*lang="[^"]*"' | grep -oE 'lang="[^"]*"' | head -1)
  # check for known copy strings
  copy="unknown"
  if printf '%s' "$body" | grep -q "Scan to join the queue"; then copy="en"; fi
  if printf '%s' "$body" | grep -q "Escaneia para entrar na fila"; then copy="pt-BR"; fi
  if printf '%s' "$body" | grep -q "Escanea para entrar a la fila"; then copy="es"; fi
  {
    echo "=== $label ==="
    echo "\$ $cmd"
    echo "GET $path  Cookie:${cookie:-none}  Accept-Language:${al:-none}"
    echo "observed lang: $lang"
    echo "observed copy signal: $copy"
    echo ""
  } >> "$OUT"
  printf '%s' "$body" > "body_${label}.html"
}

# room existence check before B
echo "room check before B:" >> "$OUT"
curl -s "$BASE/api/rooms?id=$ROOM" >> "$OUT"
echo "" >> "$OUT"

# B. /<room>/tv for room seeded en
run "B_tv_es_cookie" "/$ROOM/tv" "es" ""
run "B_tv_es_al" "/$ROOM/tv" "" "es-ES"
run "B_tv_none" "/$ROOM/tv" "" ""

echo "room check after B:" >> "$OUT"
curl -s "$BASE/api/rooms?id=$ROOM" >> "$OUT"
echo "" >> "$OUT"

# C. /default/tv with cookie es -> expect pt-BR (legacy room no record)
run "C_default_tv_es" "/default/tv" "es" ""

echo "room check before D:" >> "$OUT"
curl -s "$BASE/api/rooms?id=$ROOM" >> "$OUT"
echo "" >> "$OUT"

# D. /<room> patron page
run "D_room_es_cookie" "/$ROOM" "es" ""
run "D_room_al_only" "/$ROOM" "" "es-ES"
run "D_room_none" "/$ROOM" "" ""

echo "room check after D:" >> "$OUT"
curl -s "$BASE/api/rooms?id=$ROOM" >> "$OUT"
echo "" >> "$OUT"

# E. /<room>/admin with cookie es
run "E_room_admin_es" "/$ROOM/admin" "es" ""

echo "room check after E:" >> "$OUT"
curl -s "$BASE/api/rooms?id=$ROOM" >> "$OUT"
echo "" >> "$OUT"

echo "BCDE done"

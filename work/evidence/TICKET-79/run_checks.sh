#!/bin/bash
set -u
cd "$(dirname "$0")"
BASE=http://127.0.0.1:3196
OUT=raw_transcripts.txt
: > "$OUT"

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
  {
    echo "=== $label ==="
    echo "\$ $cmd"
    echo "GET $path  Cookie:${cookie:-none}  Accept-Language:${al:-none}"
    echo "observed: $lang"
    echo ""
  } >> "$OUT"
  printf '%s' "$body" > "body_${label}.html"
}

# A. Landing routes: / /new /admin /admin/analytics
for route in "/" "/new" "/admin" "/admin/analytics"; do
  slug=$(echo "$route" | tr '/' '_')
  run "A${slug}_none" "$route" "" ""
  run "A${slug}_es" "$route" "es" ""
  run "A${slug}_en_al" "$route" "" "en-US,en;q=0.9"
  run "A${slug}_es_cookie_en_al" "$route" "es" "en-US,en;q=0.9"
done

echo "A done"

#!/usr/bin/env bash

set -euo pipefail

BASE_URL="${BASE_URL:-http://127.0.0.1:1234}"
CONV_DIR="${CONV_DIR:-$HOME/.lmstudio/conversations}"
APP_SUPPORT_DIR="${APP_SUPPORT_DIR:-$HOME/Library/Application Support/LM Studio}"

curl_lm() {
  if [[ -n "${LM_API_TOKEN:-}" ]]; then
    curl -s -H "Authorization: Bearer $LM_API_TOKEN" "$@"
    return
  fi

  curl -s "$@"
}

SEARCH_ROOTS=()
if [[ -d "$CONV_DIR" ]]; then
  SEARCH_ROOTS+=("$CONV_DIR")
fi
if [[ -d "$APP_SUPPORT_DIR" ]]; then
  SEARCH_ROOTS+=("$APP_SUPPORT_DIR")
fi

search_marker() {
  local marker="$1"

  if [[ "${#SEARCH_ROOTS[@]}" -eq 0 ]]; then
    echo "No LM Studio storage roots found to search."
    return 0
  fi

  rg --text -n "$marker" "${SEARCH_ROOTS[@]}" || true
}

search_marker_file() {
  local marker="$1"

  if [[ "${#SEARCH_ROOTS[@]}" -eq 0 ]]; then
    return 0
  fi

  rg --text -l "$marker" "${SEARCH_ROOTS[@]}" | head -n1 || true
}

MODEL="${MODEL:-$(
  curl_lm "$BASE_URL/api/v1/models" \
    | jq -r '.models[] | select(.type=="llm") | .key' \
    | head -n1
)}"

if [[ -z "${MODEL}" ]]; then
  echo "No LLM model found from $BASE_URL/api/v1/models"
  exit 1
fi

STAMP="sidebar-poc-$(date +%Y%m%d-%H%M%S)"
PROMPT1="SIDEBAR_POC_1 $STAMP"
PROMPT2="SIDEBAR_POC_2 $STAMP"
PROMPT3="SIDEBAR_POC_3 $STAMP"

echo "BASE_URL=$BASE_URL"
echo "MODEL=$MODEL"
echo "CONV_DIR=$CONV_DIR"
echo "APP_SUPPORT_DIR=$APP_SUPPORT_DIR"
echo "SEARCH_ROOTS=${SEARCH_ROOTS[*]:-<none>}"
if [[ -d "$CONV_DIR" ]]; then
  echo "Legacy conversation file count: $(find "$CONV_DIR" -type f -name '*.json' | wc -l | tr -d ' ')"
else
  echo "Legacy conversation dir not found."
fi

RESP1="$(
  curl_lm "$BASE_URL/api/v1/chat" \
    -H 'Content-Type: application/json' \
    -d "$(jq -nc --arg model "$MODEL" --arg input "$PROMPT1" '{model:$model,input:$input}')"
)"

RESP_ID="$(printf '%s\n' "$RESP1" | jq -r '.response_id')"
echo
echo "Response 1:"
printf '%s\n' "$RESP1" | jq '{response_id, output, stats}'

sleep 2

echo
echo "Files containing PROMPT1:"
search_marker "$PROMPT1"
FILE1="$(search_marker_file "$PROMPT1")"
echo "FILE1=${FILE1:-<none>}"

RESP2="$(
  curl_lm "$BASE_URL/api/v1/chat" \
    -H 'Content-Type: application/json' \
    -d "$(jq -nc --arg model "$MODEL" --arg input "$PROMPT2" --arg prev "$RESP_ID" '{model:$model,input:$input,previous_response_id:$prev}')"
)"

echo
echo "Response 2:"
printf '%s\n' "$RESP2" | jq '{response_id, output, stats}'

sleep 2

echo
echo "Files containing PROMPT2:"
search_marker "$PROMPT2"
FILE2="$(search_marker_file "$PROMPT2")"
echo "FILE2=${FILE2:-<none>}"

RESP3="$(
  curl_lm "$BASE_URL/api/v1/chat" \
    -H 'Content-Type: application/json' \
    -d "$(jq -nc --arg model "$MODEL" --arg input "$PROMPT3" '{model:$model,input:$input,store:false}')"
)"

echo
echo "Response 3 (store:false):"
printf '%s\n' "$RESP3" | jq '{response_id, output, stats}'

sleep 2

echo
echo "Files containing PROMPT3 (expected none):"
search_marker "$PROMPT3"

echo
echo "Manual check now: switch to LM Studio and see whether a new chat appeared in the sidebar."
echo "Expected marker in GUI or underlying JSON: $STAMP"

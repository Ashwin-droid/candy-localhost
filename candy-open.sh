#!/bin/bash
# candy:// protocol handler
# Usage: candy://portal, candy://routes, candy://[domain]

URL="$1"

# Strip the candy:// prefix
PATH_PART="${URL#candy://}"
# Remove trailing slashes
PATH_PART="${PATH_PART%/}"

case "$PATH_PART" in
  "portal"|"")
    xdg-open "https://portal.localhost"
    ;;
  "routes"|"ls"|"list")
    xdg-open "https://portal.localhost/#routes"
    ;;
  "stats"|"status")
    xdg-open "https://portal.localhost/#stats"
    ;;
  *)
    # Assume it's a domain name, open it
    xdg-open "https://${PATH_PART}.localhost"
    ;;
esac

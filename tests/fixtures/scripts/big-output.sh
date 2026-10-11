#!/bin/sh
# Test fixture (read-only): prints far more output than the runner keeps.
i=0
while [ "$i" -lt 3000 ]; do
  echo "line $i of a very long read-only report"
  i=$((i + 1))
done

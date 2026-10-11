#!/bin/sh
# Test fixture: a WRITE script (retries a CI job). The static guard must reject it; never run it.
curl -s -X POST -H "PRIVATE-TOKEN: $CI_TOKEN" "https://ci.example.com/api/v4/projects/1/jobs/$1/retry"

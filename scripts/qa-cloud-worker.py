import os
import sys
import time
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
WORKER = ROOT / "worker"
if str(WORKER) not in sys.path:
    sys.path.insert(0, str(WORKER))

import cliper_worker


required = ["QA_CLOUD_API_BASE", "QA_CLOUD_ACCESS_TOKEN", "QA_CLOUD_SIGNING_SECRET"]
missing = [name for name in required if not os.environ.get(name)]
if missing:
    raise SystemExit(f"Missing QA environment: {', '.join(missing)}")

result = cliper_worker.call_openai_compatible(
    {
        "providerType": "cloud",
        "baseUrl": os.environ["QA_CLOUD_API_BASE"],
        "cloudAccessToken": os.environ["QA_CLOUD_ACCESS_TOKEN"],
        "cloudSigningSecret": os.environ["QA_CLOUD_SIGNING_SECRET"],
        "model": "auto",
        "maxTokens": 40,
        "aiRetry": 1,
        "timeoutMs": 15,
    },
    "Reply only MOCK_OK",
)

# Cloud billing requests use the same desktop HMAC as chat requests. Integral
# floats are deliberate: Python must normalize 352.0 to the Node JSON form
# (352) before it hashes and signs the body.
cloud_payload = {
    "providerType": "cloud",
    "baseUrl": os.environ["QA_CLOUD_API_BASE"],
    "cloudAccessToken": os.environ["QA_CLOUD_ACCESS_TOKEN"],
    "cloudSigningSecret": os.environ["QA_CLOUD_SIGNING_SECRET"],
    "timeoutMs": 15,
}
job = cliper_worker.cloud_job_request(
    cloud_payload,
    "/jobs/start",
    {
        "requestId": f"signature-qa-{int(time.time() * 1000)}",
        "sourceId": "signature-qa-source",
        "sourceDurationSeconds": 352.0,
        "requestedClipCount": 3,
    },
)
completed = cliper_worker.cloud_job_request(
    cloud_payload,
    "/jobs/complete",
    {
        "jobId": job["id"],
        "clipScores": [72.0, 88.0],
        "usableResult": True,
    },
)
if completed.get("status") != "completed":
    raise SystemExit("Cloud analysis job signature QA did not complete.")

print(f"{result['response']} JOB_OK")

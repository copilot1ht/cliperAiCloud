import os
import sys
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
print(result["response"])

"""Deployment contract checks; external build, download, and publish calls are fakes."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]


class ApkDeploymentTest(unittest.TestCase):
    def run_deploy(self, fail=False, firebase="valid"):
        with tempfile.TemporaryDirectory(prefix="jarvis-apk-test-") as directory:
            root = Path(directory)
            mobile = root / "apps/mobile"
            mobile.mkdir(parents=True)
            (root / "scripts").mkdir()
            shutil.copyfile(ROOT / "scripts/deploy-mobile-apk.sh", root / "scripts/deploy-mobile-apk.sh")
            (mobile / "app.json").write_text(json.dumps({"expo": {"version": "1.0.5", "android": {"versionCode": 10, "package": "com.jarvis.app"}}}))
            if firebase != "missing":
                (mobile / "google-services.json").write_text(json.dumps({
                    "project_info": {"project_number": "123", "project_id": "test"},
                    "client": [{"client_info": {
                        "mobilesdk_app_id": "1:123:android:abc",
                        "android_client_info": {"package_name": "wrong.package" if firebase == "mismatch" else "com.jarvis.app"},
                    }, "api_key": [{"current_key": "test-firebase-client-key"}]}],
                }))
            original = '{"build":{"apk":{"env":{"PRESERVE_ME":"yes"},"android":{"buildType":"apk"}}}}\n'
            (mobile / "eas.json").write_text(original)
            fakebin = root / "bin"
            fakebin.mkdir()
            scripts = {
                "npx": """#!/usr/bin/env python3
import json, os, sys
from pathlib import Path
profile = json.loads(Path('eas.json').read_text())['build']['apk']
assert profile['env'] == {
    'PRESERVE_ME': 'yes', 'EXPO_PUBLIC_API_URL': 'https://api.example.test',
    'EXPO_PUBLIC_GOOGLE_CLIENT_ID': 'test.apps.googleusercontent.com',
    'EXPO_PUBLIC_APK_DOWNLOAD_URL': 'https://download.example.test/latest.apk',
}
assert profile['android']['buildType'] == 'apk'
if os.environ.get('TEST_FAIL') == '1': sys.exit(9)
print(json.dumps([{'status':'FINISHED','artifacts':{'buildUrl':'https://build.example.test/file.apk'}}]))
""",
                "curl": """#!/usr/bin/env python3
import sys
from pathlib import Path
Path(sys.argv[sys.argv.index('--output') + 1]).write_bytes(b'signed-test-apk')
""",
                "gcloud": """#!/usr/bin/env python3
import os,sys
from pathlib import Path
with Path(os.environ['PUBLISH_CALLS']).open('a') as output: output.write(' '.join(sys.argv[1:]) + '\\n')
""",
            }
            for name, source in scripts.items():
                path = fakebin / name
                path.write_text(source)
                path.chmod(0o755)
            env = os.environ | {
                "PATH": str(fakebin) + os.pathsep + os.environ["PATH"],
                "EXPO_PUBLIC_API_URL": "https://api.example.test",
                "EXPO_PUBLIC_GOOGLE_CLIENT_ID": "test.apps.googleusercontent.com",
                "EXPO_PUBLIC_APK_DOWNLOAD_URL": "https://download.example.test/latest.apk",
                "PUBLISH_CALLS": str(root / "published"), "TMPDIR": str(root),
                "TEST_FAIL": "1" if fail else "0",
            }
            result = subprocess.run(["bash", str(root / "scripts/deploy-mobile-apk.sh")], env=env, capture_output=True, text=True)
            self.assertEqual((mobile / "eas.json").read_text(), original)
            self.assertFalse((mobile / ".eas-apk-deploy.lock").exists())
            if firebase != "valid":
                self.assertNotEqual(result.returncode, 0)
                self.assertFalse((root / "published").exists())
                self.assertIn("Firebase", result.stderr)
            elif fail:
                self.assertEqual(result.returncode, 9)
                self.assertFalse((root / "published").exists())
                self.assertIn("diagnostics retained", result.stderr)
            else:
                self.assertEqual(result.returncode, 0, result.stderr)
                published = (root / "published").read_text()
                self.assertIn("jarvis-1.0.5-10.apk", published)
                self.assertIn("releases/latest.apk", published)
                self.assertEqual(len(published.splitlines()), 3)

    def test_remote_environment_and_restore_after_success(self):
        self.run_deploy()

    def test_failed_build_restores_config_and_never_publishes(self):
        self.run_deploy(fail=True)

    def test_missing_firebase_config_never_builds_or_publishes(self):
        self.run_deploy(firebase="missing")

    def test_firebase_config_must_match_android_package(self):
        self.run_deploy(firebase="mismatch")


if __name__ == "__main__":
    unittest.main()

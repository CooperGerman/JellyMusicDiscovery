from __future__ import annotations

import hashlib
import json
import os
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile


ROOT = Path(__file__).resolve().parents[1]
PLUGIN = ROOT / "plugin"
BUILD = PLUGIN / "source" / "bin" / "Release" / "net10.0"
METADATA = PLUGIN / "source" / "meta.json"
MANIFEST = ROOT / "manifest.json"
ARTIFACT = PLUGIN / "artifacts" / "JellyMusicDiscovery.zip"
DOWNLOAD = PLUGIN / "JellyMusicDiscovery.zip"
PACKAGE_FILES = ("JellyMusicDiscovery.dll", "TagLibSharp.dll", "meta.json")


def atomic_write(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as temporary:
        temporary_path = Path(temporary.name)
        temporary.write(data)
    os.replace(temporary_path, path)


def main() -> None:
    metadata = json.loads(METADATA.read_text(encoding="utf-8"))
    version = metadata["version"]
    plugins = json.loads(MANIFEST.read_text(encoding="utf-8"))
    plugin = next((entry for entry in plugins if entry["guid"] == metadata["guid"]), None)
    if plugin is None:
        raise SystemExit(f"No manifest plugin entry found for GUID {metadata['guid']}")

    release = next(
        (entry for entry in plugin["versions"] if entry["version"] == version),
        None,
    )
    if release is None:
        raise SystemExit(
            f"Add a {version} version entry and changelog to manifest.json before packaging"
        )
    if release["targetAbi"] != metadata["targetAbi"]:
        raise SystemExit("manifest targetAbi does not match plugin meta.json")

    missing = [name for name in PACKAGE_FILES if not (BUILD / name).is_file()]
    if missing:
        raise SystemExit(f"Missing Release package files: {', '.join(missing)}")

    ARTIFACT.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(dir=ARTIFACT.parent, delete=False) as temporary:
        temporary_path = Path(temporary.name)
    try:
        with ZipFile(temporary_path, "w", ZIP_DEFLATED) as archive:
            for name in PACKAGE_FILES:
                archive.write(BUILD / name, name)
        atomic_write(ARTIFACT, temporary_path.read_bytes())
    finally:
        temporary_path.unlink(missing_ok=True)

    package_bytes = ARTIFACT.read_bytes()
    atomic_write(DOWNLOAD, package_bytes)
    release["checksum"] = hashlib.md5(package_bytes).hexdigest()
    release["timestamp"] = datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
    atomic_write(MANIFEST, (json.dumps(plugins, indent=2, ensure_ascii=False) + "\n").encode("utf-8"))

    print(f"Packaged Music Discovery {version}")
    print(f"Artifact: {ARTIFACT.relative_to(ROOT)}")
    print(f"Catalog ZIP: {DOWNLOAD.relative_to(ROOT)}")
    print(f"Manifest checksum: {release['checksum']}")


if __name__ == "__main__":
    main()
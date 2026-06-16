"""
Generate a stable-only Sparkle appcast for Maxx GitHub Releases.

Expected files in the current directory:
    - sign_update.txt: output from Sparkle's sign_update tool for Maxx.dmg

Expected environment variables:
    - MAXX_VERSION: CFBundleShortVersionString, for example 0.1.0
    - MAXX_BUILD: CFBundleVersion, monotonically increasing build number
    - MAXX_RELEASE_TAG: GitHub release tag, for example maxx-v0.1.0
    - MAXX_COMMIT: short commit hash
    - MAXX_COMMIT_LONG: full commit hash
      Legacy MOSTTLY_* names are also accepted for local release scripts.

Outputs appcast.xml in the current directory.
"""

import os
import xml.etree.ElementTree as ET
from datetime import datetime, timezone

SPARKLE_NS = "http://www.andymatuschak.org/xml-namespaces/sparkle"
REPO = "https://github.com/scottmcpherson/maxx"


def sparkle(name):
    return f"{{{SPARKLE_NS}}}{name}"


def parse_sign_update(path):
    attrs = {}
    with open(path, "r", encoding="utf-8") as f:
        for pair in f.read().split():
            key, value = pair.split("=", 1)
            value = value.strip()
            if value.startswith('"') and value.endswith('"'):
                value = value[1:-1]
            if key.startswith("sparkle:"):
                key = sparkle(key.split(":", 1)[1])
            attrs[key] = value
    return attrs


def sub(parent, tag, text):
    elem = ET.SubElement(parent, tag)
    elem.text = text
    return elem


def required_env(name, legacy_name):
    return os.environ.get(name) or os.environ[legacy_name]


ET.register_namespace("sparkle", SPARKLE_NS)

now = datetime.now(timezone.utc)
pubdate_format = "%a, %d %b %Y %H:%M:%S %z"

version = required_env("MAXX_VERSION", "MOSTTLY_VERSION")
build = required_env("MAXX_BUILD", "MOSTTLY_BUILD")
tag = required_env("MAXX_RELEASE_TAG", "MOSTTLY_RELEASE_TAG")
commit = required_env("MAXX_COMMIT", "MOSTTLY_COMMIT")
commit_long = required_env("MAXX_COMMIT_LONG", "MOSTTLY_COMMIT_LONG")

release_url = f"{REPO}/releases/tag/{tag}"
download_url = f"{REPO}/releases/download/{tag}/Maxx.dmg"

rss = ET.Element("rss", {"version": "2.0"})
channel = ET.SubElement(rss, "channel")
sub(channel, "title", "Maxx Updates")
sub(channel, "link", f"{REPO}/releases")
sub(channel, "description", "Stable macOS releases for Maxx.")
sub(channel, "language", "en")

item = ET.SubElement(channel, "item")
sub(item, "title", f"Maxx {version}")
sub(item, "pubDate", now.strftime(pubdate_format))
sub(item, sparkle("version"), build)
sub(item, sparkle("shortVersionString"), version)
sub(item, sparkle("minimumSystemVersion"), "13.0.0")
sub(item, sparkle("fullReleaseNotesLink"), release_url)
sub(
    item,
    "description",
    f"Maxx {version}, built from commit {commit} ({commit_long}).",
)

enclosure = ET.SubElement(item, "enclosure")
enclosure.set("url", download_url)
enclosure.set("type", "application/octet-stream")
for key, value in parse_sign_update("sign_update.txt").items():
    enclosure.set(key, value)

ET.ElementTree(rss).write("appcast.xml", xml_declaration=True, encoding="utf-8")

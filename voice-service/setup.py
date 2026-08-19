"""Legacy-compatible package metadata for the system Python 3.9 toolchain."""

from setuptools import find_packages, setup


setup(
    name="maxx-voice-service",
    version="0.1.0",
    description="Provider-neutral local named-voice catalog and OpenAI-compatible TTS/STT service",
    packages=find_packages(include=["voice_service", "voice_service.*"]),
    python_requires=">=3.9",
    install_requires=[],
    entry_points={"console_scripts": ["voice-service=voice_service.cli:main"]},
)

# WhisperSpeech web UI
Web UI for WhisperSpeech (https://github.com/collabora/WhisperSpeech)

## Info
[![Version](https://img.shields.io/badge/version-4.1-orange.svg)](https://github.com/Mateusz-Dera/WhisperSpeech-Web-UI/blob/main/README.md)

> [!Note]
> Versions 2.x, 3.x and 4.x allow voice generation via API.

> [!Note]
> Version 4.x supports SillyTavern (1.13.2)

### Test platforms:
|Name|Info|
|:---|:---|
|CPU|AMD Ryzen 9950X3D|
|GPU|AMD Radeon 7900XTX|
|RAM|64GB DDR5 6600MHz|
|Motherboard|ASRock B650E PG Riptide WiFi (BIOS 3.30)|
|OS|Ubuntu 24.04.2 LTS|
|Kernel|6.14.0-28-generic|
|ROCm|6.4.3|

|Name|Info|
|:---|:---|
|CPU|IntelCore i5-12500H|
|GPU|NVIDIA GeForce RTX 4050|
|RAM|16GB DDR4 3200MHz|
|Motherboard|GIGABYTE G5 MF (BIOS FB10)|
|OS|Ubuntu 25.04|
|Kernel|6.14.0-28-generic|
|NVIDIA Driver|570.169|
|CUDA|12.8|

## Instalation:
1\. Install uv and ffmpeg.

2\. Clone repository.

3\. Mount the repository directory.

3\. Create and activate venv using uv.

4\. Run webui.py:

CPU (not recommended):
```bash
uv run --extra cpu webui.py
```

ROCm 6.4:
```bash
uv run --extra rocm webui.py
```

CUDA 12.8:
```bash
uv run --extra cuda webui.py
```

## SillyTavern extension:
1\. Copy whisperspeech-webui folder to SillyTavern/public/scripts/extensions/third-party

2\. Run app with api support.

```bash
# This is example. If you are using SillyTavern locally, you can remove --listen parameter.
uv run --extra cpu webui.py --listen --api
```

3\. Launch SillyTavern. In the extensions tab, expand WhisperSpeech web UI and set the IP and port.

## GUI tanslation:
|Languages|
|:---|
|English|
|Polish|

<!-- TRANSLATION -->
1\. Extract messages.pot:
```bash
pybabel extract -F babel.cfg -o ./locale/messages.pot . 
```

2\. Generate files:

New language:
```bash
pybabel init -i ./locale/messages.pot -d ./locale -l pl_PL
# Replace pl_PL by your language
```

Update current:
```bash
pybabel update -i ./locale/messages.pot -d ./locale -l pl_PL
# Replace pl_PL by your language
```

3\. Compile:
```bash
pybabel compile -d ./locale
```

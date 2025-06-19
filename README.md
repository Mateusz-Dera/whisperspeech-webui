# WhisperSpeech web UI
Web UI for WhisperSpeech (https://github.com/collabora/WhisperSpeech)

## Info
[![Version](https://img.shields.io/badge/3.0-version-orange.svg)](https://github.com/Mateusz-Dera/WhisperSpeech-Web-UI/blob/main/README.md)

> [!Note]
> Versions 2.x and 3.x allow voice generation via API.

### Test platform:
|Name|Info|
|:---|:---|
|CPU|AMD Ryzen 9950X3D (iGPU disabled in BIOS)|
|GPU|AMD Radeon 7900XTX|
|RAM|64GB DDR5 6600MHz|
|Motherboard|ASRock B650E PG Riptide WiFi (BIOS 3.25)|
|OS|Ubuntu 24.04.2 LTS|
|Kernel|6.11.0-26-generic|
|ROCm|6.4.1|

|Name|Info|
|:---|:---|
|CPU|IntelCore i5-12500H|
|GPU|NVIDIA GeForce RTX 4050|
|RAM|16GB DDR4 3200MHz|
|Motherboard|GIGABYTE G5 MF (BIOS FB10)|
|OS|Ubuntu 24.04.2 LTS|
|Kernel|6.11.0-26-generic|
|NVIDIA Driver|570.133.07|
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

ROCm 6.3:
```bash
uv run --extra rocm webui.py
```

CUDA 12.8:
```bash
uv run --extra cuda webui.py
```

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
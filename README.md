# WhisperSpeech web UI
Web UI for WhisperSpeech

(https://github.com/collabora/WhisperSpeech)

![Preview](screenshot.png)

## Info
[![Version](https://img.shields.io/badge/2.0-version-orange.svg)](https://github.com/Mateusz-Dera/WhisperSpeech-Web-UI/blob/main/README.md)

> [!Note]
> Version 2.0 now allows voice generation via API.

### Test platforms:
|Name|Info|
|:---|:---|
|CPU|AMD Ryzen 7900X3D (iGPU disabled in BIOS)|
|GPU|AMD Radeon 7900XTX|
|RAM|64GB DDR5 6600MHz|
|Motherboard|ASRock B650E PG Riptide WiFi (BIOS 2.10)|
|OS|Ubuntu 24.04|
|Kernel|6.8.0-36-generic|
|ROCm|6.1.3|

|Name|Info|
|:---|:---|
|CPU|IntelCore i5-12500H|
|GPU|NVIDIA GeForce RTX 4050|
|RAM|16GB DDR4 3200MHz|
|Motherboard|GIGABYTE G5 MF (BIOS FB10)|
|OS|Ubuntu 24.04|
|Kernel|6.8.0-36-generic|
|NVIDIA Driver|535.183.01|

## Instalation:
1. Install Python 3.12

2. Clone repository

3. Mount the repository directory.

3. Create and activate venv

4. For ROCm set HSA_OVERRIDE_GFX_VERSION.
* For the Radeon 7900XTX:
```bash
export HSA_OVERRIDE_GFX_VERSION=11.0.0
```
5. Install ffmpeg:
```bash
sudo apt install ffmpeg
```

6. Install requirements

* CPU (not recommended):
```bash
pip install -r requrements.txt
```

* ROCm 6.0:
```bash
pip install -r requirements_rocm.txt
pip install git+https://github.com/ROCmSoftwarePlatform/flash-attention.git@2554f490101742ccdc56620a938f847f61754be6
```

* CUDA 11.8:
```bash
pip install -r requrements_cuda_11.8.txt
```

* CUDA 12.1:
```bash
pip install -r requrements_cuda_12.1.txt
```

7. Run:
```bash
python webui.py
```
* With -h or --help for help:
```bash
python webui.py -h
```

<!-- TRANSLATION -->
<!-- PYBABEL -->
<!-- EXTRACT -->
<!-- pybabel extract -F babel.cfg -o ./locale/messages.pot . -->
<!-- UPDATE -->
<!-- pybabel update -i ./locale/messages.pot -d ./locale -->
<!-- NEW LANGUAGE -->
<!-- pybabel init -i ./locale/messages.pot -d ./locale -l pl_PL -->
<!-- COMPILE -->
<!-- pybabel compile -d ./locale -->

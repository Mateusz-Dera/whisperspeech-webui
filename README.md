# WhisperSpeech web UI
Web UI for WhisperSpeech
(https://github.com/collabora/WhisperSpeech)

## Work in progress

## Info
[![Version](https://img.shields.io/badge/0.1-version-orange.svg)](https://github.com/Mateusz-Dera/WhisperSpeech-Web-UI/blob/main/README.md)

### Test platform:
|Name|Info|
|:---|:---|
|CPU|AMD Ryzen 7900X3D (iGPU disabled in BIOS)|
|GPU|AMD Radeon 7900XTX|
|RAM|64GB DDR5 6600MHz|
|Motherboard|ASRock B650E PG Riptide WiFi (2.08.AS01 [Beta])|
|OS|Ubuntu 22.04|
|Kernel|6.5.0-18-generic|
|ROCm|6.0|

## Instalation:
1. Install Python 3.11

2. Clone repository

3. Mount the repository directory.

3. Create and activate venv

4. For ROCm set HSA_OVERRIDE_GFX_VERSION.
* For the Radeon 7900XTX:
```bash
export HSA_OVERRIDE_GFX_VERSION=11.0.0
```
5. Install requirements
* For ROCm:
```bash
pip install -r requirements_rocm.txt
pip install git+https://github.com/ROCmSoftwarePlatform/flash-attention.git@ae7928c5aed53cf6e75cc792baa9126b2abfcf1a
```
* For CUDA:
```bash
Not yet tested.
```
6. Run:
```bash
python webui.py
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
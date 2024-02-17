if ! command -v python3.11 &> /dev/null; then
    echo "Install Python 3.11 first"
    exit 1
fi
python3.11 -m venv .venv
source .venv/bin/activate
cd .venv

#TODO

# pip install --pre cmake colorama filelock lit numpy Pillow Jinja2 \
#     mpmath fsspec MarkupSafe certifi filelock networkx \
#     sympy packaging requests \
#     --index-url https://download.pytorch.org/whl/nightly/rocm6.0

# pip install --pre torch torchaudio --index-url https://download.pytorch.org/whl/nightly/rocm6.0

# pip install packaging==23.2

# git clone https://github.com/arlo-phoenix/bitsandbytes-rocm-5.6.git
# cd bitsandbytes-rocm-5.6
# git checkout 62353b0200b8557026c176e74ac48b84b953a854
# BUILD_CUDA_EXT=0 pip install -r requirements.txt --extra-index-url https://download.pytorch.org/whl/nightly/rocm6.0
# make hip ROCM_TARGET=gfx1100 ROCM_HOME=/opt/rocm-6.0.0/
# pip install . --extra-index-url https://download.pytorch.org/whl/nightly/rocm6.0

# cd $installation_path/whisperspeech-webui
# git clone https://github.com/ROCmSoftwarePlatform/flash-attention.git
# cd flash-attention
# git checkout ae7928c5aed53cf6e75cc792baa9126b2abfcf1a
# pip install .
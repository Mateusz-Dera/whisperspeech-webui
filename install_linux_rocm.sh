if ! command -v python3.11 &> /dev/null; then
    echo "Install Python 3.11 first"
    exit 1
fi
python3.11 -m venv .venv
source .venv/bin/activate
pip install -r requirements_rocm.txt --extra-index-url https://download.pytorch.org/whl/rocm5.7
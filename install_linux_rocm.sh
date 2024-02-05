if ! command -v python3.11 &> /dev/null; then
    echo "Install Python 3.11 first"
    exit 1
fi
python3.11 -m venv .venv
source .venv/bin/activate
git clone https://github.com/collabora/WhisperSpeech.git
cd WhisperSpeech
git checkout 80b268b74900b2f7ca7a36a3c789607a3f4cd912
pip install -e .
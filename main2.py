# MIT License

# Copyright (c) 2024 Mateusz Dera

# Permission is hereby granted, free of charge, to any person obtaining a copy
# of this software and associated documentation files (the "Software"), to deal
# in the Software without restriction, including without limitation the rights
# to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
# copies of the Software, and to permit persons to whom the Software is
# furnished to do so, subject to the following conditions:

# The above copyright notice and this permission notice shall be included in all
# copies or substantial portions of the Software.

# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
# IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
# FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
# AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
# LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
# OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
# SOFTWARE.

import os
import argparse
import sys
import gettext
import re
from datetime import datetime
import threading
import json
from http.server import HTTPServer, BaseHTTPRequestHandler
from urllib.parse import parse_qs
import socket

import torch
import gradio as gr
import numpy
from pydub import AudioSegment
from rich_argparse import RichHelpFormatter
from whisperspeech.pipeline import Pipeline

# Define translation domain and bind it to the 'locales' directory
gettext.bindtextdomain('messages', localedir='locale')
gettext.textdomain('messages')
_ = gettext.gettext

# Define available models
MODELS = {
    "small": "collabora/whisperspeech:s2a-q4-small-en+pl.model",
    "tiny": "collabora/whisperspeech:s2a-q4-tiny-en+pl.model",
    "base": "collabora/whisperspeech:s2a-q4-base-en+pl.model"
}

def get_ip():
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        # doesn't even have to be reachable
        s.connect(('10.255.255.255', 1))
        IP = s.getsockname()[0]
    except Exception:
        IP = '127.0.0.1'
    finally:
        s.close()
    return IP

# Use user parameter for server port
parser = argparse.ArgumentParser(add_help=False, formatter_class=RichHelpFormatter)
parser.add_argument("-p", "--port", type=int, default=7860, help=_("Specify the server port for the GUI."))
parser.add_argument('-a', '--auth', metavar=(_("<u>:<p>")), help=_("Enter the username <u> and password <p> for authorization."))
parser.add_argument('-l', '--listen', action='store_true', help=_("Host the app on the local network."))
parser.add_argument('-s', '--share', action='store_true', help=_("Create a public sharing tunnel."))
parser.add_argument('-h', '--help', action='help', default=argparse.SUPPRESS, help=_("Show this help message and exit."))
parser.add_argument('-i', '--api', action='store_true', help=_("Enable API mode"))
parser.add_argument('-o', '--api-port', type=int, default=5050, help=_("Specify the server port for the API."))
parser.add_argument('-m', '--model', choices=MODELS.keys(), default="small", help=_("Select the default model (small, tiny, or base)"))
args = parser.parse_args()

# Set the default model
default_model = MODELS[args.model]

info = _("This is a simple web UI for the %s project. %s %s") % ("<b>WhisperSpeech</b>","<br>https://github.com/Mateusz-Dera/whisperspeech-webui","<br>https://github.com/collabora/WhisperSpeech")

def split_text(text):
    sentences_with_tags = re.findall(r'(<en>|<pl>)?\s*([^<]*)', text)
    sentences = [(tag.strip("<>") if tag else "en", sentence.strip()) for tag, sentence in sentences_with_tags if sentence.strip()]

    return ["  " + element[1] + "  "  for element in sentences],[element[0] for element in sentences]

# Model, text, slider value, voice, audio format
def update(m,t,s,v,af):
    if not torch.cuda.is_available():
        cuda_device = _("No CUDA device available.")
        gr.Error(cuda_device) 
        print(cuda_device)
    else:
        print(_("CUDA device available."))

    print("\n",m,"\n",t,"\n",s,"\n",v,"\n",af)
    pipe = Pipeline(s2a_ref=m)

    speaker = pipe.default_speaker

    if v != None:
        speaker = pipe.extract_spk_emb(v)

    split = split_text(t)
    print(split[0])
    print(split[1])
    tensor = pipe.vocoder.decode(pipe.s2a.generate(pipe.t2s.generate(split[0], cps=s, lang=split[1])[0], speaker.unsqueeze(0)))

    np = (tensor.cpu().numpy() * 32767).astype(numpy.int16)

    if len(np.shape) == 1:
        np = np.expand_dims(np, axis=0)
    else:
        np = np.T

    try:
        audio_segment = AudioSegment(
            np.tobytes(), 
            frame_rate=24000, 
            sample_width=2, 
            channels=1
        )
        filename = '%s/outputs/audio_%s.%s' % (os.path.dirname(os.path.realpath(__file__)), datetime.now().strftime('%Y-%m-%d_%H:%M:%S'), af)
        audio_segment.export(filename, format=af)
        print(_("Audio file generated: %s") % filename)
        return filename
    except Exception as e:
        file_error = str(_("Error:"), f"{e}")
        gr.Error(file_error)
        print(file_error)

# API functionality
class WhisperSpeechHandler(BaseHTTPRequestHandler):
    def do_POST(self):
        if self.path == '/generate':
            content_length = int(self.headers['Content-Length'])
            post_data = self.rfile.read(content_length)
            data = json.loads(post_data.decode('utf-8'))

            text = data.get('text', '')
            speed = data.get('speed', 13.5)
            audio_format = data.get('format', 'wav')

            output_file = update(default_model, text, speed, None, audio_format)

            if output_file:
                self.send_response(200)
                self.send_header('Content-type', f'audio/{audio_format}')
                self.send_header('Access-Control-Allow-Origin', '*')  # Allow CORS
                self.end_headers()
                with open(output_file, 'rb') as file:
                    self.wfile.write(file.read())
            else:
                self.send_error(500, "Error generating audio")
        else:
            self.send_error(404, "Not Found")

    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.end_headers()

def run_api(host, port):
    server_address = (host, port)
    httpd = HTTPServer(server_address, WhisperSpeechHandler)
    print(f"API running on http://{host}:{port}")
    httpd.serve_forever()

# Gradio UI setup
with gr.Blocks(
    theme=gr.themes.Soft(
        primary_hue="orange",
        secondary_hue="amber",
    ),
    title=(_("WhisperSpeech Web UI"))
    ) as demo:
    
    with gr.Row():
        with gr.Column():
            gr.Markdown(info)
            
            model = gr.Dropdown(choices=list(MODELS.values()), label=_("Model"), value=default_model, interactive=True)
        
            text = gr.Textbox(
                placeholder=_("Enter your text here..."),
                label=_("Text"),
                value=("English is default language.")
            )

            description = _("You can use the *&lt;en&gt;* and *&lt;pl&gt;* tags to change languages and even combine them.")
            warning = _("Combining languages can produce mixed results.")
            example = _("Example:")
            gr.Markdown("%s %s<br><br>%s<br>*&lt;pl&gt;To jest tekst w języku polskim.&lt;en&gt; And this is text in English.*" % (description, warning, example))

            slider = gr.Slider(
                label=_("Characters per second"),
                minimum=10,
                maximum=15,
                value=13.5,
                step=0.25,
                interactive=True
            )
            
            voice = gr.Audio(
                label=_("Voice to clone (optional)"),
                type="filepath"
            )
            
            gr.Markdown("<br>")

            formats = [
                "wav",
                "mp3",
                "ogg"
            ]

            audio_format = gr.Dropdown(choices=formats, label=_("Audio format"), value=formats[0], interactive=True)

            btn = gr.Button(_("Generate"),variant="primary")
            
        out = gr.Audio(
            label=_("Output"),
            interactive = False
        )
        
        btn.click(fn=update, inputs=[model,text,slider,voice,audio_format], outputs=out)

# Main execution
if __name__ == "__main__":
    host = "127.0.0.1"
    if args.listen or args.share:
        host = "0.0.0.0"

    # Start API in a separate thread if enabled
    if args.api:
        api_host = host
        api_thread = threading.Thread(target=run_api, args=(api_host, args.api_port))
        api_thread.start()
        
        if api_host == "0.0.0.0":
            print(f"API accessible at:")
            print(f"  - http://localhost:{args.api_port}")
            print(f"  - http://{get_ip()}:{args.api_port}")

    # Launch Gradio UI
    if args.auth is not None:
        try:
            user, password = args.auth.split(":")
            if user == "" or password == "" or user is None or password is None:
                raise Exception
        except:
            print(_("Invalid username and/or password."))
            sys.exit(1)

        demo.launch(server_port=args.port, server_name=host, auth=(user,password), share=args.share)
    else:
        demo.launch(server_port=args.port, server_name=host, share=args.share)

    # If API is running, wait for it to finish
    if args.api:
        api_thread.join()
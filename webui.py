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
from datetime import datetime

import gradio as gr
from pydub import AudioSegment
import numpy as np
from whisperspeech.pipeline import Pipeline

# Define translation domain and bind it to the 'locales' directory
gettext.bindtextdomain('messages', localedir='locales')
gettext.textdomain('messages')
_ = gettext.gettext

# Use user parameter for server port
# TODO: default values as parameters
# TODO: language as parameter
# TODO: generate output folder if not exists
parser = argparse.ArgumentParser(add_help=False)
parser.add_argument("--port", "-p", type=int, default=7860, help=_("Specify the server port."))
parser.add_argument('-h', '--help', action='help', default=argparse.SUPPRESS, help=_("Show this help message and exit."))
args = parser.parse_args()

info = _("This is a simple web UI for the %s project. %s %s") % ("<b>WhisperSpeech</b>","<br>https://github.com/Mateusz-Dera/WhisperSpeech-Web-UI","<br>https://github.com/collabora/WhisperSpeech")

def update(a,b,c,d):
    print("\n",a,"\n",b,"\n",c,"\n",d)
    pipe = Pipeline(s2a_ref=a)

    # TODO: Split by <> and select the language
    audio_tensor = pipe.generate(b)

    audio_np = (audio_tensor.cpu().numpy() * 32767).astype(np.int16)

    if len(audio_np.shape) == 1:
        audio_np = np.expand_dims(audio_np, axis=0)
    else:
        audio_np = audio_np.T

    print("Array shape:", audio_np.shape)
    print("Array dtype:", audio_np.dtype)

    # TODO: Select audio format & rate
    try:
        audio_segment = AudioSegment(
            audio_np.tobytes(), 
            frame_rate=24000, 
            sample_width=2, 
            channels=1
        )
        format = 'wav'
        filename = '%s/outputs/audio_%s.%s' % (os.path.dirname(os.path.realpath(__file__)), datetime.now().strftime('%Y-%m-%d_%H:%M:%S'), format)
        audio_segment.export(filename, format=format)
        print(_("Audio file generated: %s") % filename)
    except Exception as e:
        # TODO: Translations
        print(f_("Error writing audio file: {e}"))

# TODO: Add language selection
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
            
            models = [
                "collabora/whisperspeech:s2a-q4-small-en+pl.model", 
                "collabora/whisperspeech:s2a-q4-tiny-en+pl.model", 
                "collabora/whisperspeech:s2a-q4-base-en+pl.model"
            ]

            model = gr.Dropdown(choices=models, label=_("Model"), value=models[0], interactive=True)

            text = gr.Textbox(
                placeholder=_("Enter your text here..."),
                label=_("Text"),
                value=_("<en> This is the text in English.")
            )
            
            slider = gr.Slider(
                label=_("Characters per second"),
                minimum=10,
                maximum=15,
                value=15,
                step=0.25,
                interactive=True
            )
            
            audio = gr.Audio(
                label=_("Voice to clone (optional)"),
            )
            
            gr.Markdown("<br>")

            btn = gr.Button(_("Generate"),variant="primary")
            
        out = gr.Textbox(
            label=_("Output"),
            interactive = False
        )
        
        btn.click(fn=update, inputs=[model,text,slider,audio], outputs=out)

# Launch the demo with the specified port
demo.launch(server_port=args.port)
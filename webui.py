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

import argparse
import sys
import gettext
import gradio as gr

# Define translation domain and bind it to the 'locales' directory
gettext.bindtextdomain('messages', localedir='locales')
gettext.textdomain('messages')
_ = gettext.gettext

# Use user parameter for server port
parser = argparse.ArgumentParser(add_help=False)
parser.add_argument("--port", "-p", type=int, default=7860, help=_("Specify the server port."))
parser.add_argument('-h', '--help', action='help', default=argparse.SUPPRESS, help=_("Show this help message and exit."))
args = parser.parse_args()

info = _("This is a simple web UI for the %s project. %s %s") % ("<b>WhisperSpeech</b>","<br>https://github.com/Mateusz-Dera/WhisperSpeech-Web-UI","<br>https://github.com/collabora/WhisperSpeech")

def update(a):
    return f"Welcome to Gradio!"

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
            
            inp = gr.Textbox(
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
        
        btn.click(fn=update, inputs=inp, outputs=out)

# Launch the demo with the specified port
demo.launch(server_port=args.port)
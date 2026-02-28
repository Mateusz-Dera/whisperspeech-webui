# MIT License

# Copyright (c) 2024-2026 Mateusz Dera

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
import tempfile
import shutil
from http.server import HTTPServer, BaseHTTPRequestHandler
from urllib.parse import parse_qs
import socket
import io
from email.parser import BytesParser
from email.message import EmailMessage
import uuid
import time

import torch
import gradio as gr
import numpy
from pydub import AudioSegment
from rich_argparse import RichHelpFormatter
from whisperspeech.pipeline import Pipeline

# Version
version = '4.2.1'

# CSS
css = '''
a {color: orange;}
::selection {color: white; background: orange;}
'''

# Define translation domain and bind it to the 'locales' directory
gettext.bindtextdomain('messages', localedir='locale')
gettext.textdomain('messages')
_ = gettext.gettext

# Define available models
MODELS = {
    'tiny': 'collabora/whisperspeech:s2a-q4-tiny-en+pl.model',
    'small': 'collabora/whisperspeech:s2a-q4-small-en+pl.model',
    'base': 'collabora/whisperspeech:s2a-q4-base-en+pl.model'
}

# Model cache for performance
model_cache = {}

# Active tasks tracking for cancellation
active_tasks = {}
task_lock = threading.Lock()

# Text
info = '%s<br><br>%s<br><a %s</a><br><a %s</a>' % (
    _('This is a simple web UI for the %s project.') % '<b>WhisperSpeech</b>',
    '<b>' + _('Version:') + '</b> ' + version,
    'href="https://github.com/Mateusz-Dera/whisperspeech-webui">https://github.com/Mateusz-Dera/whisperspeech-webui',
    'href="https://github.com/collabora/WhisperSpeech">https://github.com/collabora/WhisperSpeech'
)

def get_ip():
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        # Doesn't even have to be reachable
        s.connect(('10.255.255.255', 1))
        IP = s.getsockname()[0]
    except Exception:
        IP = '127.0.0.1'
    finally:
        s.close()
    return IP

# Create a custom formatter class
class CustomHelpFormatter(RichHelpFormatter):
    def __init__(self, prog):
        super().__init__(prog, max_help_position=35, width=100)

# Argument parser
parser = argparse.ArgumentParser(add_help=False,  formatter_class=CustomHelpFormatter)
parser.add_argument('-p', '--port', metavar=(_('<port>')), type=int, default=7860, help=_('Specify the server port for the GUI.'))
parser.add_argument('-a', '--auth', metavar=(_('<u>:<p>')), help=_('Enter the username <u> and password <p> for authorization.'))
parser.add_argument('-l', '--listen', action='store_true', help=_('Host the app on the local network.'))
parser.add_argument('-s', '--share', action='store_true', help=_('Create a public sharing tunnel.'))
parser.add_argument('-h', '--help', action='help', default=argparse.SUPPRESS, help=_('Show this help message and exit.'))
parser.add_argument('-i', '--api', action='store_true', help=_('Enable API mode.'))
parser.add_argument('-o', '--api-port', metavar=(_('<port>')), type=int, default=5050, help=_('Specify the server port for the API.'))
parser.add_argument('-m', '--model', choices=MODELS.keys(), default="tiny", help=_('Select the default model tiny/small/base.'))
parser.add_argument('-v', '--api-voice', metavar=(_('<path>')), help=_('Specify the path to an mp3, wav, or ogg file for voice cloning when using the API.'))
args = parser.parse_args()

# Set the default model
default_model = MODELS[args.model]

class CancellableTask:
    def __init__(self, task_id):
        self.task_id = task_id
        self.cancelled = False
        self.result = None
        self.error = None
        self.completed = False
        self.lock = threading.Lock()
    
    def cancel(self):
        with self.lock:
            self.cancelled = True
    
    def is_cancelled(self):
        with self.lock:
            return self.cancelled
    
    def set_result(self, result):
        with self.lock:
            if not self.cancelled:
                self.result = result
                self.completed = True
    
    def set_error(self, error):
        with self.lock:
            if not self.cancelled:
                self.error = error
                self.completed = True

def create_task(task_id):
    """Create and register a new task"""
    task = CancellableTask(task_id)
    with task_lock:
        active_tasks[task_id] = task
    return task

def get_task(task_id):
    """Get task by ID"""
    with task_lock:
        return active_tasks.get(task_id)

def remove_task(task_id):
    """Remove task from active tasks"""
    with task_lock:
        if task_id in active_tasks:
            del active_tasks[task_id]

def split_text(text):
    sentences_with_tags = re.findall(r'(<en>|<pl>)?\s*([^<]*)', text)
    sentences = [(tag.strip('<>') if tag else 'en', sentence.strip()) for tag, sentence in sentences_with_tags if sentence.strip()]

    return ['  ' + element[1] + '  '  for element in sentences],[element[0] for element in sentences]

def load_model(model_name):
    """Load model with caching for better performance"""
    global model_cache
    if model_name not in model_cache:
        print(_('Loading model: %s') % model_name)
        model_cache[model_name] = Pipeline(s2a_ref=model_name)
    return model_cache[model_name]

# Model, text, slider value, voice, audio format, autoplay, task_id (optional)
def update(m, t, s, v, af, ap, task_id=None):
    if not torch.cuda.is_available():
        cuda_device = _('No ROCm/CUDA device available.')
        gr.Error(cuda_device)
        print(cuda_device)
    else:
        print(_('ROCm/CUDA device available.'))

    print('\n', m, '\n', t, '\n', s, '\n', v, '\n', af, '\n', ap)
    
    # Check if task is cancelled
    if task_id:
        task = get_task(task_id)
        if task and task.is_cancelled():
            print(f"Task {task_id} was cancelled before starting")
            return None
    
    # Load or get cached model
    pipe = load_model(m)

    # Handle voice cloning if provided
    speaker = None
    if v is not None:
        if task_id:
            task = get_task(task_id)
            if task and task.is_cancelled():
                print(f"Task {task_id} was cancelled during voice processing")
                return None
        speaker = pipe.extract_spk_emb(v)

    # Split text and get language tags
    split_sentences, split_langs = split_text(t)
    print(split_sentences)
    print(split_langs)
    
    # Generate audio for each sentence segment
    audio_segments = []
    
    for i, (sentence, lang) in enumerate(zip(split_sentences, split_langs)):
        if sentence.strip():  # Only process non-empty sentences
            # Check if task is cancelled before each sentence
            if task_id:
                task = get_task(task_id)
                if task and task.is_cancelled():
                    print(f"Task {task_id} was cancelled during sentence {i+1}")
                    return None
            
            try:
                # Generate audio using the new API
                # The new generate method handles text, language, speed, and speaker internally
                if speaker is not None:
                    # With voice cloning
                    audio_tensor = pipe.generate(
                        sentence,
                        lang=lang,
                        cps=s,
                        speaker=speaker
                    )
                else:
                    # Without voice cloning (use default speaker)
                    audio_tensor = pipe.generate(
                        sentence,
                        lang=lang,
                        cps=s
                    )
                
                audio_segments.append(audio_tensor)
                
            except TypeError:
                # Fallback if the new API doesn't support all parameters
                # Try without lang and cps parameters
                try:
                    if speaker is not None:
                        audio_tensor = pipe.generate(sentence, speaker=speaker)
                    else:
                        audio_tensor = pipe.generate(sentence)
                    audio_segments.append(audio_tensor)
                except Exception as e:
                    print(f"Error generating segment: {e}")
                    # Final fallback to old method if needed
                    old_tensor = pipe.vocoder.decode(
                        pipe.s2a.generate(
                            pipe.t2s.generate([sentence], cps=s, lang=[lang])[0],
                            speaker.unsqueeze(0) if speaker is not None else pipe.default_speaker.unsqueeze(0)
                        )
                    )
                    audio_segments.append(old_tensor)
    
    # Check if task is cancelled before concatenation
    if task_id:
        task = get_task(task_id)
        if task and task.is_cancelled():
            print(f"Task {task_id} was cancelled before concatenation")
            return None
    
    # Concatenate all audio segments
    if len(audio_segments) > 1:
        # Convert to numpy arrays and concatenate
        np_segments = []
        for tensor in audio_segments:
            np_seg = (tensor.cpu().numpy() * 32767).astype(numpy.int16)
            if len(np_seg.shape) == 1:
                np_seg = numpy.expand_dims(np_seg, axis=0)
            else:
                np_seg = np_seg.T
            np_segments.append(np_seg)
        
        # Concatenate along the time axis
        np = numpy.concatenate(np_segments, axis=1)
    else:
        # Single segment
        tensor = audio_segments[0] if audio_segments else None
        if tensor is None:
            return None
            
        np = (tensor.cpu().numpy() * 32767).astype(numpy.int16)
        if len(np.shape) == 1:
            np = numpy.expand_dims(np, axis=0)
        else:
            np = np.T

    # Check if task is cancelled before saving
    if task_id:
        task = get_task(task_id)
        if task and task.is_cancelled():
            print(f"Task {task_id} was cancelled before saving")
            return None

    try:
        # Create outputs directory if it doesn't exist
        outputs_dir = os.path.join(os.path.dirname(os.path.realpath(__file__)), 'outputs')
        os.makedirs(outputs_dir, exist_ok=True)
        
        audio_segment = AudioSegment(
            np.tobytes(),
            frame_rate=24000,
            sample_width=2,
            channels=1
        )
        filename = os.path.join(outputs_dir, 'audio_%s.%s' % (datetime.now().strftime('%Y-%m-%d_%H-%M-%S'), af))
        audio_segment.export(filename, format=af)
        print(_('Audio file generated: %s') % filename)
        return filename
    except Exception as e:
        file_error = str(_('Error:')) + f' {e}'
        gr.Error(file_error)
        print(file_error)

def check_extension(filename):
    """Check if file has valid audio extension"""
    allowed_extensions = ('.mp3', '.ogg', '.wav')
    return filename.lower().endswith(allowed_extensions)

def save_uploaded_file(file_data, filename):
    """Save uploaded file data to a temporary file"""
    # Create temporary directory if it doesn't exist
    temp_dir = os.path.join(tempfile.gettempdir(), 'whisperspeech_api')
    os.makedirs(temp_dir, exist_ok=True)
    
    # Generate unique filename
    timestamp = datetime.now().strftime('%Y%m%d_%H%M%S_%f')
    file_extension = os.path.splitext(filename)[1] if filename else '.wav'
    temp_filename = os.path.join(temp_dir, f'voice_{timestamp}{file_extension}')
    
    # Save file data
    with open(temp_filename, 'wb') as f:
        f.write(file_data)
    
    return temp_filename

def cleanup_temp_file(filepath):
    """Clean up temporary file"""
    try:
        if os.path.exists(filepath):
            os.remove(filepath)
            print(f"Cleaned up temporary file: {filepath}")
    except Exception as e:
        print(f"Error cleaning up temporary file {filepath}: {e}")

def parse_multipart_form_data(body, boundary):
    """Parse multipart form data without using cgi module"""
    # Add the required dashes to boundary
    boundary = b'--' + boundary
    
    # Split the body by boundary
    parts = body.split(boundary)
    
    form_data = {}
    files = {}
    
    for part in parts[1:-1]:  # Skip first (empty) and last (closing boundary)
        if not part.strip():
            continue
            
        # Split headers and content
        try:
            header_end = part.find(b'\r\n\r\n')
            if header_end == -1:
                header_end = part.find(b'\n\n')
                if header_end == -1:
                    continue
                headers_raw = part[:header_end]
                content = part[header_end+2:]
            else:
                headers_raw = part[:header_end]
                content = part[header_end+4:]
            
            # Parse headers
            headers = {}
            for header_line in headers_raw.split(b'\n'):
                header_line = header_line.strip()
                if b':' in header_line:
                    key, value = header_line.split(b':', 1)
                    headers[key.strip().lower()] = value.strip()
            
            # Extract field name and filename from Content-Disposition
            content_disposition = headers.get(b'content-disposition', b'')
            field_name = None
            filename = None
            
            # Parse Content-Disposition header
            for item in content_disposition.split(b';'):
                item = item.strip()
                if item.startswith(b'name='):
                    field_name = item[5:].strip(b'"\'')
                elif item.startswith(b'filename='):
                    filename = item[9:].strip(b'"\'')
            
            if not field_name:
                continue
                
            # Remove trailing CRLF if present
            if content.endswith(b'\r\n'):
                content = content[:-2]
            elif content.endswith(b'\n'):
                content = content[:-1]
            
            # Store the data
            field_name = field_name.decode('utf-8', errors='replace')
            if filename:
                # It's a file
                files[field_name] = {
                    'filename': filename.decode('utf-8', errors='replace'),
                    'data': content
                }
            else:
                # It's a regular form field
                form_data[field_name] = content.decode('utf-8', errors='replace')
                
        except Exception as e:
            print(f"Error parsing multipart part: {e}")
            continue
    
    return form_data, files

def generate_audio_task(model, text, speed, voice_file, audio_format, task_id):
    """Generate audio in a separate thread"""
    try:
        result = update(model, text, speed, voice_file, audio_format, False, task_id)
        task = get_task(task_id)
        if task:
            if task.is_cancelled():
                # Clean up result file if it was created
                if result and os.path.exists(result):
                    try:
                        os.remove(result)
                    except:
                        pass
                print(f"Task {task_id} was cancelled, cleaned up result")
            else:
                task.set_result(result)
    except Exception as e:
        task = get_task(task_id)
        if task and not task.is_cancelled():
            task.set_error(str(e))
        print(f"Error in task {task_id}: {e}")

# API functionality
class WhisperSpeechHandler(BaseHTTPRequestHandler):
    def do_POST(self):
        if self.path == '/generate':
            temp_voice_file = None
            task_id = None
            try:
                content_type = self.headers.get('Content-Type', '')
                
                if content_type.startswith('multipart/form-data'):
                    # Handle multipart form data (file upload)
                    # Extract boundary from content type
                    boundary = None
                    for item in content_type.split(';'):
                        item = item.strip()
                        if item.startswith('boundary='):
                            boundary = item[9:].strip('"\'')
                            break
                    
                    if not boundary:
                        self.send_error(400, _('No boundary found in multipart request.'))
                        return
                    
                    # Read the body
                    content_length = int(self.headers['Content-Length'])
                    body = self.rfile.read(content_length)
                    
                    # Parse multipart data
                    form_data, files = parse_multipart_form_data(body, boundary.encode())
                    
                    # Extract form fields
                    text = form_data.get('text', '')
                    speed = float(form_data.get('speed', 13.5))
                    audio_format = form_data.get('format', 'wav')
                    model_key = form_data.get('model', args.model)
                    
                    # Handle uploaded voice file
                    voice_file = None
                    if 'voice' in files:
                        voice_data = files['voice']
                        filename = voice_data['filename']
                        
                        # Validate file extension
                        if not check_extension(filename):
                            self.send_error(400, _('Invalid file format. Please use mp3, wav, or ogg.'))
                            return
                        
                        # Save to temporary file
                        temp_voice_file = save_uploaded_file(voice_data['data'], filename)
                        voice_file = temp_voice_file
                        print(f"Uploaded voice file saved: {temp_voice_file}")
                    
                elif content_type.startswith('application/json'):
                    # Handle JSON data (no file upload)
                    content_length = int(self.headers['Content-Length'])
                    post_data = self.rfile.read(content_length)
                    data = json.loads(post_data.decode('utf-8'))
                    
                    text = data.get('text', '')
                    speed = data.get('speed', 13.5)
                    audio_format = data.get('format', 'wav')
                    model_key = data.get('model', args.model)
                    voice_file = args.api_voice if args.api_voice else None
                else:
                    self.send_error(400, _('Unsupported content type.'))
                    return

                # Map model key to full model name
                model = MODELS.get(model_key, default_model)

                # Create task
                task_id = str(uuid.uuid4())
                task = create_task(task_id)

                # Start generation in a separate thread
                generation_thread = threading.Thread(
                    target=generate_audio_task,
                    args=(model, text, speed, voice_file, audio_format, task_id)
                )
                generation_thread.start()

                # Wait for completion or cancellation
                start_time = time.time()
                timeout = 300  # 5 minutes timeout
                
                while not task.completed and not task.is_cancelled() and (time.time() - start_time) < timeout:
                    time.sleep(0.1)

                if task.is_cancelled():
                    # Task was cancelled
                    self.send_response(499)  # Client Closed Request
                    self.send_header('Content-type', 'application/json')
                    self.send_header('Access-Control-Allow-Origin', '*')
                    self.end_headers()
                    
                    response = {'error': 'Task was cancelled'}
                    self.wfile.write(json.dumps(response).encode('utf-8'))
                    print(f"Task {task_id} was cancelled")
                    
                elif task.completed and task.result:
                    # Task completed successfully
                    output_file = task.result
                    
                    if os.path.exists(output_file):
                        # Send response
                        self.send_response(200)
                        self.send_header('Content-type', f'audio/{audio_format}')
                        self.send_header('Access-Control-Allow-Origin', '*')
                        self.send_header('X-Task-ID', task_id)
                        
                        # Add filename to response headers
                        filename = os.path.basename(output_file)
                        self.send_header('Content-Disposition', f'attachment; filename="{filename}"')
                        
                        # Calculate file size
                        file_size = os.path.getsize(output_file)
                        self.send_header('Content-Length', str(file_size))
                        
                        self.end_headers()
                        
                        # Send file content
                        with open(output_file, 'rb') as file:
                            shutil.copyfileobj(file, self.wfile)
                        
                        print(f"API response sent: {output_file}")
                    else:
                        self.send_error(500, _('Error generating audio.'))
                        
                elif task.completed and task.error:
                    # Task completed with error
                    self.send_error(500, f'{_("Generation error:")} {task.error}')
                    
                else:
                    # Timeout
                    task.cancel()
                    self.send_error(504, _('Request timeout.'))
                    
            except json.JSONDecodeError:
                self.send_error(400, _('Invalid JSON data.'))
            except ValueError as e:
                self.send_error(400, f'{_("Invalid parameter:")} {str(e)}')
            except Exception as e:
                print(f"API Error: {e}")
                self.send_error(500, f'{_("Internal server error:")} {str(e)}')
            finally:
                # Clean up
                if temp_voice_file:
                    cleanup_temp_file(temp_voice_file)
                if task_id:
                    remove_task(task_id)
                    
        elif self.path.startswith('/cancel/'):
            # Handle cancellation
            task_id = self.path.split('/')[-1]
            task = get_task(task_id)
            
            if task:
                task.cancel()
                self.send_response(200)
                self.send_header('Content-type', 'application/json')
                self.send_header('Access-Control-Allow-Origin', '*')
                self.end_headers()
                
                response = {'message': f'Task {task_id} cancelled'}
                self.wfile.write(json.dumps(response).encode('utf-8'))
                print(f"Task {task_id} cancelled via API")
            else:
                self.send_error(404, _('Task not found.'))
        else:
            self.send_error(404, _('Not found.'))

    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'POST, GET, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.end_headers()

    def do_GET(self):
        """Handle GET requests for connection testing"""
        if self.path == '/' or self.path == '/status':
            self.send_response(200)
            self.send_header('Content-type', 'application/json')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            
            # Send server status information
            status = {
                'status': 'ok',
                'service': 'WhisperSpeech API',
                'version': version,
                'endpoints': ['/generate', '/cancel/{task_id}', '/status'],
                'active_tasks': len(active_tasks)
            }
            self.wfile.write(json.dumps(status).encode('utf-8'))
        else:
            self.send_error(404, _('Not found.'))

    def log_message(self, format, *args):
        """Override to provide better logging"""
        print(f"API Request: {self.address_string()} - {format % args}")

def run_api(host, port):
    server_address = (host, port)
    httpd = HTTPServer(server_address, WhisperSpeechHandler)
    print(_('API running on http://%s:%s') % (host,port))

    httpd.serve_forever()

# Gradio UI setup
with gr.Blocks(
    title=(_('WhisperSpeech Web UI')),
    css=css
    ) as demo:

    with gr.Row():
        with gr.Column():
            gr.Markdown(info)

            model = gr.Dropdown(choices=list(MODELS.values()), label=_('Model'), value=default_model, interactive=True)

            text = gr.Textbox(
                placeholder=_('Enter your text here...'),
                label=_('Text'),
                value=('English is default language.')
            )

            description = _('You can use the *&lt;en&gt;* and *&lt;pl&gt;* tags to change languages and even combine them.')
            warning = _('Combining languages can produce mixed results.')
            example = _('Example:')
            gr.Markdown('%s %s<br><br>%s<br>*&lt;pl&gt;To jest tekst w języku polskim.&lt;en&gt; And this is text in English.*' % (description, warning, example))

            slider = gr.Slider(
                label=_('Characters per second'),
                minimum=10,
                maximum=15,
                value=13.5,
                step=0.25,
                interactive=True
            )

            voice = gr.Audio(
                label=_('Voice to clone (optional)'),
                type='filepath'
            )

            gr.Markdown('<br>')

            formats = [
                'wav',
                'mp3',
                'ogg'
            ]

            audio_format = gr.Dropdown(choices=formats, label=_('Audio format'), value=formats[0], interactive=True)

            with gr.Row():
                btn = gr.Button(_('Generate'),variant='primary')
                autoplay = gr.Checkbox(
                    label=_('Autoplay'),
                    value=True,
                    interactive=True
                )

        out = gr.Audio(
            label=_('Output'),
            interactive = False,
            autoplay=True
        )

        # Update audio component with autoplay value
        def update_audio_and_autoplay(m, t, s, v, af, ap):
            audio_file = update(m, t, s, v, af, ap)
            return gr.Audio(value=audio_file, autoplay=ap)

        btn.click(fn=update_audio_and_autoplay, inputs=[model,text,slider,voice,audio_format,autoplay], outputs=out)

def is_port_available(port):
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        try:
            s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            s.bind(('127.0.0.1', port))
            s.listen(1)
            return True
        except OSError:
            return False

def find_available_port(start_port):
    port = start_port
    while not is_port_available(port):
        port += 1
    return port

# Main execution
if __name__ == '__main__':
    print(_('Version:') + ' ' + version)
    host = '127.0.0.1'
    if args.listen or args.share:
        host = '0.0.0.0'

    # Find an available port starting from the specified port
    port = find_available_port(args.port)
    if port != args.port:
        print(_('Port %s is busy. Using port %s instead.') % (args.port,port))

    # Start API in a separate thread if enabled
    if args.api:
        if args.api_voice:
            if not os.path.exists(args.api_voice):
                print(_('The specified voice file does not exist.'))
                sys.exit(1)

            if not check_extension(args.api_voice):
                print(_('The specified voice file must be in mp3, wav, or ogg format.'))
                sys.exit(1)

        api_host = host
        api_port = find_available_port(args.api_port)

        if api_port != args.api_port:
            print(_('API port %s is busy. Using port %s instead.') % (args.api_port,api_port))

        if api_port == port:
            print(_('API port %s is the same as the GUI port. Using port %s instead.') % (api_port,api_port + 1))
            api_port = find_available_port(api_port + 1)

        print("\n")

        api_thread = threading.Thread(target=run_api, args=(api_host, api_port))
        api_thread.start()

    # Launch Gradio UI
    if args.auth is not None:
        try:
            user, password = args.auth.split(':')
            if user == '' or password == '' or user is None or password is None:
                raise Exception
        except:
            print(_('Invalid username and/or password.'))
            sys.exit(1)

        demo.launch(server_port=port, server_name=host, auth=(user,password), share=args.share)
    else:
        demo.launch(server_port=port, server_name=host, share=args.share)

    # If API is running, wait for it to finish
    if args.api:
        api_thread.join()
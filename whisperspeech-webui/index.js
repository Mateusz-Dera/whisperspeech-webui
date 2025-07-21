// MIT License

// Copyright (c) 2024-2025 Mateusz Dera

// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:

// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.

// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

import { extension_settings, getContext } from "../../../extensions.js";
import { eventSource, event_types, saveSettings } from "../../../../script.js";

const extensionName = "whisperspeech-webui";
const extensionFolderPath = `scripts/extensions/third-party/${extensionName}`;

// Default settings
const defaultSettings = {
    enabled: true,
    url: "http://127.0.0.1:5050",
    language: "<en>",
    narrate_user: false,
    auto_generation: false,
    auto_generate_audio: false,
    quotes: false,
    split_quotes: false,
    speed: 13.5,
    voice_file: null,
    voice_file_data: null,
    voice_file_type: null,
    model: "tiny",
    auto_hide_audio: false
};

// Test messages for different languages
const testMessages = {
    "<en>": "Hello, this is a test message!",
    "<pl>": "Cześć, to jest testowa wiadomość!"
};

// Global variables for cancellation
let testAbortController = null;
let currentTestTaskId = null;
let messageAbortControllers = new Map(); // Track abort controllers for each message
let messageTaskIds = new Map(); // Track task IDs for each message
let messageGenerationStates = new Map(); // Track generation states for proper cancellation

// Global audio playback queue for proper message order
let globalAudioQueue = [];
let isPlayingQueue = false;
let currentlyPlayingMessage = null;
let currentMessageAudioIndex = 0; // Track which audio file we're currently playing within a message
let isPaused = false;
let pausedAudioElement = null;
let pausedPosition = 0;

// Function to load settings
function loadSettings() {
    extension_settings[extensionName] = extension_settings[extensionName] || {};
    if (Object.keys(extension_settings[extensionName]).length === 0) {
        Object.assign(extension_settings[extensionName], defaultSettings);
    }
    
    // Migration: Convert old ip/port format to new url format
    if (extension_settings[extensionName].ip && extension_settings[extensionName].port) {
        const ip = extension_settings[extensionName].ip;
        const port = extension_settings[extensionName].port;
        extension_settings[extensionName].url = `http://${ip}:${port}`;
        delete extension_settings[extensionName].ip;
        delete extension_settings[extensionName].port;
        saveSettings();
    }
}

// Function to validate URL format
function isValidUrl(string) {
    try {
        const url = new URL(string);
        return url.protocol === 'http:' || url.protocol === 'https:';
    } catch (_) {
        return false;
    }
}

// Function to get message timestamp for ordering
function getMessageTimestamp(messageContainer) {
    // First try to get the DOM index as a more reliable ordering method
    const allMessages = $('.mes');
    const domIndex = allMessages.index(messageContainer);
    
    if (domIndex !== -1) {
        // Use DOM index * 1000 to create timestamp-like ordering
        // Earlier messages in DOM = lower timestamp
        const domTimestamp = domIndex * 1000;
        console.log(`Message DOM index: ${domIndex}, calculated timestamp: ${domTimestamp}`);
        return domTimestamp;
    }
    
    // Fallback to trying to extract timestamp from various sources
    const timeElement = messageContainer.find('.timestamp, .mes_time, [data-timestamp]');
    if (timeElement.length) {
        const timestamp = timeElement.attr('data-timestamp') || timeElement.text();
        const parsed = parseInt(timestamp);
        if (!isNaN(parsed)) return parsed;
    }
    
    // Final fallback
    return Date.now();
}

// Wait for earlier messages to finish generating
async function waitForEarlierMessagesToFinish(timestamp) {
    return new Promise((resolve) => {
        const checkInterval = setInterval(() => {
            if (!hasEarlierMessagesGenerating(timestamp)) {
                clearInterval(checkInterval);
                console.log(`Earlier messages finished generating, can now process message with timestamp ${timestamp}`);
                resolve();
            }
        }, 500); // Check every 500ms
    });
}

// Check if there are messages with earlier timestamps still generating
function hasEarlierMessagesGenerating(timestamp) {
    console.log(`Checking for earlier messages generating before timestamp ${timestamp}`);
    
    // Check all generation states for messages with earlier timestamps
    for (const [messageId, generationState] of messageGenerationStates.entries()) {
        if (generationState && !generationState.cancelled) {
            // Get message container for this messageId
            const messageContainer = $(`.mes[data-mes-id="${messageId}"]`);
            if (messageContainer.length) {
                const messageTimestamp = getMessageTimestamp(messageContainer);
                console.log(`Checking message ${messageId}: timestamp ${messageTimestamp} vs ${timestamp}, generating: ${!generationState.cancelled}`);
                
                if (messageTimestamp < timestamp) {
                    console.log(`Found earlier message ${messageId} (${messageTimestamp}) still generating, newer message (${timestamp}) must wait`);
                    return true;
                }
            }
        }
    }
    
    console.log(`No earlier messages generating found for timestamp ${timestamp}`);
    return false;
}

// Check if there are messages with earlier timestamps in the queue that haven't finished
function hasEarlierMessagesInQueue(timestamp) {
    return globalAudioQueue.some(item => item.timestamp < timestamp && !item.processed);
}

// Check if ANY messages are currently generating
function hasAnyMessagesGenerating() {
    const generatingCount = messageGenerationStates.size;
    console.log(`Currently ${generatingCount} messages generating`);
    return generatingCount > 0;
}

// Update audio queue with new audio files (can be called multiple times for same message)
function updateAudioInQueue(messageId, audioPlayers, messageContainer, timestamp) {
    if (!extension_settings[extensionName].auto_generation) {
        return; // Don't add to queue if auto-play is disabled
    }
    
    console.log(`Updating audio for message ${messageId} with ${audioPlayers.length} audio files`);
    
    // Find existing entry for this message
    let existingItem = globalAudioQueue.find(item => item.messageId === messageId);
    
    if (existingItem) {
        // Update existing entry with new audio files (don't reset processed status)
        const wasProcessed = existingItem.processed;
        const lastPlayedIndex = existingItem.lastPlayedIndex || -1;
        
        existingItem.audioPlayers = audioPlayers;
        existingItem.totalExpected = audioPlayers.length;
        
        console.log(`Updated existing queue item for ${messageId}, now has ${audioPlayers.length} audio files (processed: ${wasProcessed}, lastPlayed: ${lastPlayedIndex})`);
        
        // Don't restart processing if already processed - the streaming playback will handle new audio
        return;
    } else {
        // Create new entry
        globalAudioQueue.push({
            messageId: messageId,
            audioPlayers: audioPlayers,
            messageContainer: messageContainer,
            timestamp: timestamp,
            processed: false,
            totalExpected: audioPlayers.length,
            lastPlayedIndex: -1
        });
        
        // Sort queue by timestamp
        globalAudioQueue.sort((a, b) => a.timestamp - b.timestamp);
        console.log(`Added new message ${messageId} to audio queue with ${audioPlayers.length} audio files`);
    }
    
    console.log(`Audio queue now has ${globalAudioQueue.length} items`);
    
    // Update queue control button
    updateQueueControlButton();
    
    // Check if we can start processing this message immediately
    checkAndStartQueueProcessing(messageId, timestamp);
}

// Check if we can start processing the queue or continue with current message
function checkAndStartQueueProcessing(messageId, timestamp) {
    // If currently processing and this is the same message, continue
    if (currentlyPlayingMessage === messageId) {
        return; // Already processing this message
    }
    
    // Check if there are earlier messages still generating
    if (hasEarlierMessagesGenerating(timestamp)) {
        console.log(`Message ${messageId} added to queue but waiting for earlier messages to finish generating`);
        return; // Don't start processing yet, wait for earlier messages
    }
    
    // Check if there are earlier messages in queue that are not processed
    if (hasEarlierMessagesInQueue(timestamp)) {
        console.log(`Message ${messageId} added to queue but waiting for earlier messages in queue`);
        return; // Don't start processing yet
    }
    
    // Check if this message should be the next one in queue
    const sortedQueue = [...globalAudioQueue].sort((a, b) => a.timestamp - b.timestamp);
    const nextMessage = sortedQueue.find(item => !item.processed);
    
    if (nextMessage && nextMessage.messageId === messageId) {
        console.log(`Message ${messageId} is next in queue and has audio ready, starting playback`);
        // Process queue if not already processing
        if (!isPlayingQueue) {
            processAudioQueue();
        }
    } else {
        console.log(`Message ${messageId} added to queue but waiting for earlier messages`);
    }
}

// Continue playing current message with newly available audio (legacy support)
async function continuePlayingCurrentMessage() {
    const currentItem = globalAudioQueue.find(item => item.messageId === currentlyPlayingMessage);
    if (!currentItem || !currentItem.audioPlayers) {
        return;
    }
    
    // This function is now mainly for compatibility
    // The main streaming logic is handled in playMessageAudioStreaming
    console.log(`continuePlayingCurrentMessage called for ${currentlyPlayingMessage} (legacy support)`);
}

// Global audio queue management (backwards compatibility - now calls updateAudioInQueue)
function addToAudioQueue(messageId, audioPlayers, messageContainer, timestamp) {
    updateAudioInQueue(messageId, audioPlayers, messageContainer, timestamp);
}

// Process the audio queue in order with streaming playback
async function processAudioQueue() {
    if (isPlayingQueue || globalAudioQueue.length === 0) {
        return;
    }
    
    isPlayingQueue = true;
    console.log("Starting audio queue processing");
    updateQueueControlButton();
    
    while (globalAudioQueue.length > 0) {
        const queueItem = globalAudioQueue.find(item => !item.processed);
        if (!queueItem) {
            break; // All items processed
        }
        
        // Check if there are earlier messages still generating before processing this item
        if (hasEarlierMessagesGenerating(queueItem.timestamp)) {
            console.log(`Waiting for earlier messages to finish generating before processing ${queueItem.messageId}`);
            
            // Wait for earlier messages to finish generating
            await waitForEarlierMessagesToFinish(queueItem.timestamp);
        }
        
        console.log(`Processing audio for message ${queueItem.messageId}`);
        currentlyPlayingMessage = queueItem.messageId;
        currentMessageAudioIndex = 0;
        queueItem.processed = true;
        queueItem.lastPlayedIndex = -1;
        
        // Start streaming playback - play available audio files and continue as new ones become available
        await playMessageAudioStreaming(queueItem);
        
        console.log(`Completed all audio for message ${queueItem.messageId}`);
        
        // Remove processed item from queue
        globalAudioQueue = globalAudioQueue.filter(item => item.messageId !== queueItem.messageId);
    }
    
    currentlyPlayingMessage = null;
    currentMessageAudioIndex = 0;
    isPlayingQueue = false;
    isPaused = false;
    pausedAudioElement = null;
    pausedPosition = 0;
    console.log("Audio queue processing completed");
    updateQueueControlButton();
}

// Play audio for a message in streaming fashion
async function playMessageAudioStreaming(queueItem) {
    const messageId = queueItem.messageId;
    let currentIndex = 0;
    
    console.log(`Starting streaming playback for message ${messageId}`);
    
    while (true) {
        // Wait if paused
        while (isPaused) {
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        
        // Check if we have audio at current index
        if (queueItem.audioPlayers && queueItem.audioPlayers[currentIndex]) {
            const audioPlayer = queueItem.audioPlayers[currentIndex];
            if (audioPlayer && audioPlayer.src) {
                console.log(`Playing audio ${currentIndex + 1} for message ${messageId}`);
                queueItem.lastPlayedIndex = currentIndex;
                
                try {
                    await playAudioAndWait(audioPlayer);
                    console.log(`Finished playing audio ${currentIndex + 1} for message ${messageId}`);
                } catch (error) {
                    console.log(`Failed to play audio ${currentIndex + 1} for message ${messageId}:`, error);
                }
                
                currentIndex++;
                continue;
            }
        }
        
        // Check if this message is still generating
        const isStillGenerating = messageGenerationStates.has(messageId);
        
        if (!isStillGenerating) {
            // Generation finished, no more audio files will come
            console.log(`Generation finished for message ${messageId}, stopping at index ${currentIndex}`);
            break;
        }
        
        // Still generating, wait a bit for next audio file
        console.log(`Waiting for audio ${currentIndex + 1} for message ${messageId} (still generating)`);
        
        // Wait with timeout
        const maxWaitTime = 15000; // 15 seconds max wait per audio file
        const startTime = Date.now();
        let audioFound = false;
        
        while (Date.now() - startTime < maxWaitTime) {
            // Check if generation was cancelled
            if (!messageGenerationStates.has(messageId)) {
                console.log(`Generation cancelled for message ${messageId}, stopping wait`);
                break;
            }
            
            // Check if audio became available
            if (queueItem.audioPlayers && queueItem.audioPlayers[currentIndex] && queueItem.audioPlayers[currentIndex].src) {
                console.log(`Audio ${currentIndex + 1} became available for message ${messageId}`);
                audioFound = true;
                break;
            }
            
            // Wait a bit before checking again
            await new Promise(resolve => setTimeout(resolve, 200));
        }
        
        if (!audioFound) {
            // Check again if generation finished while we were waiting
            if (!messageGenerationStates.has(messageId)) {
                console.log(`Generation finished for message ${messageId} while waiting, stopping`);
                break;
            } else {
                console.log(`Timeout waiting for audio ${currentIndex + 1} for message ${messageId}, skipping`);
                currentIndex++;
                // Continue to next audio file
            }
        }
        
        // If we've waited too long and there are many missing audio files, stop
        if (currentIndex > 50) { // Safety limit
            console.log(`Too many audio files processed for message ${messageId}, stopping`);
            break;
        }
    }
}

// Helper function to play audio and wait for it to finish
function playAudioAndWait(audioPlayer) {
    return new Promise((resolve, reject) => {
        if (!audioPlayer || !audioPlayer.src) {
            resolve();
            return;
        }
        
        const onEnded = () => {
            audioPlayer.removeEventListener('ended', onEnded);
            audioPlayer.removeEventListener('error', onError);
            audioPlayer.removeEventListener('pause', onPause);
            resolve();
        };
        
        const onError = (error) => {
            audioPlayer.removeEventListener('ended', onEnded);
            audioPlayer.removeEventListener('error', onError);
            audioPlayer.removeEventListener('pause', onPause);
            reject(error);
        };
        
        const onPause = () => {
            if (isPaused) {
                pausedAudioElement = audioPlayer;
                pausedPosition = audioPlayer.currentTime;
                console.log(`Audio paused at position: ${pausedPosition}`);
                // Don't resolve/reject, just wait for resume
            }
        };
        
        audioPlayer.addEventListener('ended', onEnded);
        audioPlayer.addEventListener('error', onError);
        audioPlayer.addEventListener('pause', onPause);
        
        // If resuming from pause, set position and resume
        if (isPaused && pausedAudioElement === audioPlayer) {
            audioPlayer.currentTime = pausedPosition;
            isPaused = false;
            pausedAudioElement = null;
            pausedPosition = 0;
        }
        
        audioPlayer.play().catch(error => {
            console.log("Auto-play was prevented:", error);
            // If autoplay is prevented, still resolve to continue queue
            onEnded();
        });
    });
}

// Pause the audio queue
function pauseAudioQueue() {
    if (!isPlayingQueue) {
        console.log("Audio queue is not playing");
        return;
    }
    
    if (isPaused) {
        console.log("Audio queue is already paused");
        return;
    }
    
    isPaused = true;
    
    // Find and pause the currently playing audio element
    const audioElements = document.querySelectorAll('audio');
    for (const audio of audioElements) {
        if (!audio.paused) {
            audio.pause();
            console.log("Paused audio queue");
            break;
        }
    }
    
    updateQueueControlButton();
}

// Resume the audio queue
function resumeAudioQueue() {
    if (!isPaused) {
        console.log("Audio queue is not paused");
        return;
    }
    
    if (pausedAudioElement) {
        pausedAudioElement.currentTime = pausedPosition;
        pausedAudioElement.play().catch(error => {
            console.log("Auto-play was prevented on resume:", error);
        });
        console.log("Resumed audio queue from position:", pausedPosition);
    }
    
    isPaused = false;
    updateQueueControlButton();
}

// Toggle pause/resume
function toggleAudioQueue() {
    if (isPaused) {
        resumeAudioQueue();
    } else {
        pauseAudioQueue();
    }
}

// Update the queue control button appearance
function updateQueueControlButton() {
    const button = document.querySelector('.whisperspeech_queue_control');
    if (!button) return;
    
    // Check if there's any audio available (either in queue or currently playing)
    const hasAudio = globalAudioQueue.length > 0 || isPlayingQueue;
    
    if (!hasAudio) {
        // No audio available - disable the button
        button.className = 'whisperspeech_queue_control fa-solid fa-play';
        button.title = 'No audio playing';
        button.style.opacity = '0.5';
        button.style.cursor = 'not-allowed';
        button.style.pointerEvents = 'none';
    } else if (isPaused) {
        button.className = 'whisperspeech_queue_control fa-solid fa-play interactable';
        button.title = 'Resume audio queue';
        button.style.opacity = '1';
        button.style.cursor = 'pointer';
        button.style.pointerEvents = 'auto';
    } else if (isPlayingQueue) {
        button.className = 'whisperspeech_queue_control fa-solid fa-pause interactable';
        button.title = 'Pause audio queue';
        button.style.opacity = '1';
        button.style.cursor = 'pointer';
        button.style.pointerEvents = 'auto';
    } else {
        button.className = 'whisperspeech_queue_control fa-solid fa-play interactable';
        button.title = 'No audio playing';
        button.style.opacity = '1';
        button.style.cursor = 'pointer';
        button.style.pointerEvents = 'auto';
    }
}

// Clear entire queue and restart from a specific message
function clearQueueAndRestartFromMessage(messageId) {
    console.log(`Clearing queue and restarting from message: ${messageId}`);
    
    // Stop any currently playing audio
    pauseAudioQueue();
    
    // Clear the entire queue
    globalAudioQueue = [];
    
    // Reset queue state
    isPlayingQueue = false;
    isPaused = false;
    currentlyPlayingMessage = null;
    currentMessageAudioIndex = 0;
    pausedAudioElement = null;
    pausedPosition = 0;
    
    // Stop any currently playing audio elements
    const audioElements = document.querySelectorAll('audio');
    for (const audio of audioElements) {
        audio.pause();
        audio.currentTime = 0;
    }
    
    // Find the message container for the clicked message
    const clickedMessageContainer = $(`.mes[data-mes-id="${messageId}"]`);
    if (clickedMessageContainer.length === 0) {
        console.log(`Could not find message container for ID: ${messageId}`);
        return;
    }
    
    // Get the timestamp of the clicked message
    const clickedTimestamp = getMessageTimestamp(clickedMessageContainer);
    
    // Find all messages from the clicked message onwards (including newer messages)
    const allMessages = $('.mes').toArray();
    const messagesToQueue = [];
    
    for (const messageContainer of allMessages) {
        const $messageContainer = $(messageContainer);
        const messageTimestamp = getMessageTimestamp($messageContainer);
        
        // Include this message and all newer messages
        if (messageTimestamp >= clickedTimestamp) {
            let msgId = $messageContainer.attr('data-mes-id');
            if (!msgId) {
                msgId = 'msg_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
                $messageContainer.attr('data-mes-id', msgId);
            }
            
            // Check if this message has audio files or is in a state where it should be queued
            const audioContainer = $messageContainer.find('.whisperspeech_audio_container');
            const audioFiles = audioContainer.find('audio');
            const isGenerating = messageGenerationStates.has(msgId);
            
            if (audioFiles.length > 0 || isGenerating) {
                messagesToQueue.push({
                    messageId: msgId,
                    container: $messageContainer,
                    timestamp: messageTimestamp
                });
            }
        }
    }
    
    // Sort messages by timestamp to ensure proper order
    messagesToQueue.sort((a, b) => a.timestamp - b.timestamp);
    
    // Add messages to queue
    for (const msgData of messagesToQueue) {
        const audioContainer = msgData.container.find('.whisperspeech_audio_container');
        const audioFiles = audioContainer.find('audio').toArray();
        
        if (audioFiles.length > 0) {
            // Add to queue with existing audio files
            updateAudioInQueue(msgData.messageId, audioFiles, msgData.timestamp);
        } else if (messageGenerationStates.has(msgData.messageId)) {
            // Audio is still being generated, add empty queue item that will be updated
            updateAudioInQueue(msgData.messageId, [], msgData.timestamp);
        }
    }
    
    // Update button states
    updateQueueControlButton();
    
    // Start processing the queue
    processAudioQueue();
}

// Clear audio queue for a specific message
function removeFromAudioQueue(messageId) {
    const initialLength = globalAudioQueue.length;
    globalAudioQueue = globalAudioQueue.filter(item => item.messageId !== messageId);
    
    if (globalAudioQueue.length !== initialLength) {
        console.log(`Removed message ${messageId} from audio queue`);
    }
    
    // If currently playing message was removed, stop processing
    if (currentlyPlayingMessage === messageId) {
        currentlyPlayingMessage = null;
        // Don't set isPlayingQueue = false here, let it finish naturally
    }
}

// Handle message variant switching (swipe actions)
function handleMessageVariantSwitch(messageContainer, swipeDirection) {
    const messageId = messageContainer.attr('data-mes-id');
    
    if (!messageId) {
        console.log("No message ID found for variant switch");
        return;
    }
    
    console.log(`Handling message variant switch for message: ${messageId}, direction: ${swipeDirection}`);
    
    // Cancel any ongoing generation for this message
    if (messageGenerationStates.has(messageId)) {
        console.log(`Cancelling ongoing generation for message ${messageId} due to variant switch`);
        handleMessageCancel(messageId);
    }
    
    // Remove message from audio queue
    removeFromAudioQueue(messageId);
    
    // Clear existing audio container for this message
    const audioContainer = messageContainer.find('.whisperspeech_audio_container');
    if (audioContainer.length) {
        // Clean up any blob URLs to prevent memory leaks
        audioContainer.find('audio').each(function() {
            const src = $(this).attr('src');
            if (src && src.startsWith('blob:')) {
                URL.revokeObjectURL(src);
            }
        });
        
        // Remove the entire audio container
        audioContainer.remove();
        console.log(`Removed audio container for message ${messageId}`);
    }
    
    // Update queue control button
    updateQueueControlButton();
    
    // Handle different swipe scenarios
    if (swipeDirection === 'left') {
        // Going to previous variant - immediately generate audio for existing content
        handlePreviousVariant(messageContainer, messageId);
    } else if (swipeDirection === 'right') {
        // Going to next variant - check if it's existing content or new generation
        handleNextVariant(messageContainer, messageId);
    }
}

// Handle swipe left (previous variant)
function handlePreviousVariant(messageContainer, messageId) {
    console.log(`Handling previous variant for message ${messageId}`);
    
    // Check if there's existing content and auto-generation is enabled
    const messageText = messageContainer.find('.mes_text').text().trim();
    
    if (messageText && shouldAutoGenerate(messageContainer)) {
        console.log(`Generating audio for previous variant ${messageId}`);
        
        // Small delay to ensure DOM is updated with variant content
        setTimeout(() => {
            const generateButton = messageContainer.find('.whisperspeech_generate_btn');
            if (generateButton.length > 0) {
                generateButton.trigger('click');
            }
        }, 300);
    }
}

// Handle swipe right (next variant)
function handleNextVariant(messageContainer, messageId) {
    console.log(`Handling next variant for message ${messageId}`);
    
    // Check if this is existing content or if we need to wait for new generation
    const messageText = messageContainer.find('.mes_text').text().trim();
    
    if (messageText) {
        // This is an existing variant - generate audio immediately
        if (shouldAutoGenerate(messageContainer)) {
            console.log(`Generating audio for next variant ${messageId}`);
            
            setTimeout(() => {
                const generateButton = messageContainer.find('.whisperspeech_generate_btn');
                if (generateButton.length > 0) {
                    generateButton.trigger('click');
                }
            }, 300);
        }
    } else {
        // This might be a new message being generated
        console.log(`Next variant appears to be new content generation for ${messageId}`);
        
        // Set up a watcher for new content
        waitForNewMessageContent(messageContainer, messageId);
    }
}

// Wait for new message content to be generated and then create audio
function waitForNewMessageContent(messageContainer, messageId) {
    console.log(`Waiting for new message content for ${messageId}`);
    
    let checkAttempts = 0;
    const maxAttempts = 50; // 10 seconds maximum wait
    
    const contentWatcher = setInterval(() => {
        checkAttempts++;
        
        const messageText = messageContainer.find('.mes_text').text().trim();
        
        if (messageText) {
            // New content has appeared
            console.log(`New content detected for message ${messageId}, generating audio`);
            clearInterval(contentWatcher);
            
            if (shouldAutoGenerate(messageContainer)) {
                // Small delay to ensure content is fully loaded
                setTimeout(() => {
                    const generateButton = messageContainer.find('.whisperspeech_generate_btn');
                    if (generateButton.length > 0) {
                        generateButton.trigger('click');
                    }
                }, 500);
            }
        } else if (checkAttempts >= maxAttempts) {
            // Stop watching after timeout
            console.log(`Timeout waiting for new content for message ${messageId}`);
            clearInterval(contentWatcher);
        }
    }, 200); // Check every 200ms
}

// Create HTML for the plugin
function getHtml() {
    return `
    <div>
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>WhisperSpeech web UI</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <div>
                    <div>
                        <div style="display: flex; gap: 10px; align-items: center;">
                            <input class="flex1 heightFitContent text_pole margin0" type="text" id="whisperspeech_webui_url" placeholder="http://127.0.0.1:5050" value="http://127.0.0.1:5050" />
                            <div id="whisperspeech_connect_btn" class="menu_button interactable">Test</div>
                        </div>
                        <div id="whisperspeech_connection_status" style="margin-top: 10px; font-size: 14px; display: none;"></div>
                        <hr>
                        <label class="checkbox_label" for="whisperspeech_enable">
                            <input type="checkbox" id="whisperspeech_enable" name="whisperspeech_enable">
                            <small data-i18n="whisperspeech_enable">Enabled</small>
                        </label>
                        <label class="checkbox_label" for="whisperspeech_narrate_user">
                            <input type="checkbox" id="whisperspeech_narrate_user" name="whisperspeech_narrate_user">
                            <small data-i18n="whisperspeech_narrate_user">Narrate user messages</small>
                        </label>
                        <label class="checkbox_label" for="whisperspeech_auto_generation">
                            <input type="checkbox" id="whisperspeech_auto_generation" name="whisperspeech_auto_generation">
                            <small data-i18n="whisperspeech_auto_generation">Auto-play generated audio</small>
                        </label>
                        <label class="checkbox_label" for="whisperspeech_auto_generate_audio">
                            <input type="checkbox" id="whisperspeech_auto_generate_audio" name="whisperspeech_auto_generate_audio">
                            <small data-i18n="whisperspeech_auto_generate_audio">Auto-generate audio for new messages</small>
                        </label>
                        <label class="checkbox_label" for="whisperspeech_quotes">
                            <input type="checkbox" id="whisperspeech_quotes" name="whisperspeech_quotes">
                            <small data-i18n="whisperspeech_quotes">Only narrate "quotes"</small>
                        </label>
                        <label class="checkbox_label" for="whisperspeech_split_quotes" title="When enabled with 'Only narrate quotes', each sentence will be generated as a separate audio file">
                            <input type="checkbox" id="whisperspeech_split_quotes" name="whisperspeech_split_quotes">
                            <small data-i18n="whisperspeech_split_quotes">Split "quotes" into separate audio files per sentence</small>
                        </label>
                        <label class="checkbox_label" for="whisperspeech_auto_hide_audio" title="Audio files list will be hidden by default">
                            <input type="checkbox" id="whisperspeech_auto_hide_audio" name="whisperspeech_auto_hide_audio">
                            <small data-i18n="whisperspeech_auto_hide_audio">Auto-hide audio files</small>
                        </label>
                        <hr>
                        <p>Default language:</p>
                        <select id="whisperspeech_language" class="flex1">
                            <option value="<en>">English</option>
                            <option value="<pl>">Polish</option>
                        </select>
                        <hr>
                        <p>Model:</p>
                        <select id="whisperspeech_model" class="flex1">
                            <option value="tiny">Tiny</option>
                            <option value="small">Small</option>
                            <option value="base">Base</option>
                        </select>
                        <hr>
                        <label for="whisperspeech_speed_bar">
                            Characters per second: 
                            <span id="whisperspeech_speed">13.5</span>
                        </label>
                        <input id="whisperspeech_speed_bar" type="range" value="13.5" min="10" max="15" step="0.25" />
                        <hr>
                        Voice to clone (optional):
                        <br>
                        <label for="whisperspeech_voice_file" class="menu_button interactable" style="display: inline-block;">
                            Upload
                            <input type="file" id="whisperspeech_voice_file" accept=".wav,.mp3,.ogg" style="display: none;" />
                        </label>
                        <div id="whisperspeech_clear_voice" class="menu_button interactable" style="display: none; margin-left: 10px;">
                            Clear
                        </div>
                        <div id="whisperspeech_voice_controls" style="display: none; margin-top: 10px;">
                            <audio id="whisperspeech_audio_player" controls style="width: 100%; max-width: 300px;"></audio>
                        </div>

                        <hr>
                        User voice to clone (optional):
                        <br>
                        <label for="whisperspeech_user_voice_file" class="menu_button interactable" style="display: inline-block;">
                            Upload
                            <input type="file" id="whisperspeech_user_voice_file" accept=".wav,.mp3,.ogg" style="display: none;" />
                        </label>
                        <div id="whisperspeech_clear_user_voice" class="menu_button interactable" style="display: none; margin-left: 10px;">
                            Clear
                        </div>
                        <div id="whisperspeech_user_voice_controls" style="display: none; margin-top: 10px;">
                            <audio id="whisperspeech_user_audio_player" controls style="width: 100%; max-width: 300px;"></audio>
                        </div>

                        <hr>
                        Test message:
                        <div style="display: flex; gap: 10px; align-items: center;">
                            <input class="flex1 heightFitContent text_pole margin0" type="text" id="whisperspeech_test_message" placeholder="Hello, this is a test message!" value="Hello, this is a test message!" />
                            <div id="whisperspeech_test_btn" class="menu_button interactable" tabindex="0">Test</div>
                            <div id="whisperspeech_test_cancel_btn" class="menu_button interactable" tabindex="0" style="display: none; background-color: #dc3545; color: white;">Cancel</div>
                        </div>
                        <div id="whisperspeech_test_status" style="margin-top: 10px; font-size: 14px; display: none;"></div>
                        <div id="whisperspeech_test_audio" style="display: none; margin-top: 10px;">
                            <audio id="whisperspeech_test_player" controls style="width: 100%;"></audio>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    </div>
    `;
}

// Function to update test message based on language
function updateTestMessage(language) {
    const message = testMessages[language] || testMessages["<en>"];
    $("#whisperspeech_test_message")
        .attr("placeholder", message)
        .val(message);
}

// Function to convert file to base64
function fileToBase64(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.readAsDataURL(file);
        reader.onload = () => resolve(reader.result);
        reader.onerror = error => reject(error);
    });
}

// Function to convert base64 to blob
function base64ToBlob(base64, mimeType) {
    const byteCharacters = atob(base64.split(',')[1]);
    const byteNumbers = new Array(byteCharacters.length);
    for (let i = 0; i < byteCharacters.length; i++) {
        byteNumbers[i] = byteCharacters.charCodeAt(i);
    }
    const byteArray = new Uint8Array(byteNumbers);
    return new Blob([byteArray], { type: mimeType });
}

// Function to load and display saved voice file
function loadSavedVoiceFile() {
    if (extension_settings[extensionName].voice_file_data && 
        extension_settings[extensionName].voice_file_type) {
        try {
            const blob = base64ToBlob(
                extension_settings[extensionName].voice_file_data, 
                extension_settings[extensionName].voice_file_type
            );
            const audioUrl = URL.createObjectURL(blob);
            $("#whisperspeech_audio_player").attr("src", audioUrl);
            $("#whisperspeech_voice_controls").show();
            $("#whisperspeech_clear_voice").css("display", "inline-block");
            return audioUrl;
        } catch (error) {
            console.error("Error loading saved voice file:", error);
            // Clear corrupted data
            extension_settings[extensionName].voice_file = null;
            extension_settings[extensionName].voice_file_data = null;
            extension_settings[extensionName].voice_file_type = null;
            saveSettings();
        }
    }
    return null;
}

function loadSavedUserVoiceFile() {
    if (extension_settings[extensionName].user_voice_file_data && 
        extension_settings[extensionName].user_voice_file_type) {
        try {
            const blob = base64ToBlob(
                extension_settings[extensionName].user_voice_file_data, 
                extension_settings[extensionName].user_voice_file_type
            );
            const audioUrl = URL.createObjectURL(blob);
            $("#whisperspeech_user_audio_player").attr("src", audioUrl);
            $("#whisperspeech_user_voice_controls").show();
            $("#whisperspeech_clear_user_voice").css("display", "inline-block");
            return audioUrl;
        } catch (error) {
            console.error("Error loading saved user voice file:", error);
            // Clear corrupted data
            extension_settings[extensionName].user_voice_file = null;
            extension_settings[extensionName].user_voice_file_data = null;
            extension_settings[extensionName].user_voice_file_type = null;
            saveSettings();
        }
    }
    return null;
}

// Function to check if a message is from user (more comprehensive check)
function isUserMessage(messageContainer) {
    // Check for standard user message class
    if (messageContainer.hasClass('mes_user')) {
        return true;
    }
    
    // Check for user name in message
    const userName = getContext()?.name1 || 'You';
    const messageNameElement = messageContainer.find('.name_text');
    if (messageNameElement.length && messageNameElement.text().trim() === userName) {
        return true;
    }
    
    // Check for specific user message indicators
    const messageId = messageContainer.attr('data-mes-id');
    const messageIndex = messageContainer.attr('mesid');
    
    // Additional checks for user messages
    const isUser = messageContainer.hasClass('user_mes') || 
                   messageContainer.find('.name_text').text().includes('{{user}}') ||
                   messageContainer.find('.mes_text').attr('data-user') === 'true';
    
    return isUser;
}

// Function to add Generate button to messages
function addGenerateButtons() {
    // Only add buttons if extension is enabled
    if (!extension_settings[extensionName] || !extension_settings[extensionName].enabled) {
        // Remove existing buttons if disabled
        $(".whisperspeech_generate_btn").remove();
        console.log("Extension disabled - removed all generate buttons");
        return;
    }
    
    // Add CSS to disable scrolling for mes_buttons
    if (!$('#whisperspeech-styles').length) {
        $('<style id="whisperspeech-styles">.mes_buttons { overflow: hidden !important; }</style>').appendTo('head');
    }
    
    // Find all message containers that don't already have a generate button
    $(".mes_buttons").each(function() {
        const messageContainer = $(this).closest('.mes');
        const isUser = isUserMessage(messageContainer);
        const narrateUserEnabled = extension_settings[extensionName].narrate_user;
        
        console.log(`Message check: isUser=${isUser}, narrateUserEnabled=${narrateUserEnabled}, classes="${messageContainer.attr('class')}"`);
        
        // Skip user messages if narrate_user is disabled
        if (isUser && !narrateUserEnabled) {
            // Remove button if it exists
            $(this).find(".whisperspeech_generate_btn").remove();
            console.log("Removed generate button from user message (narration disabled)");
            return;
        }
        
        if (!$(this).find(".whisperspeech_generate_btn").length) {
            // Create the generate button without mes_edit class to avoid conflicts
            const generateButton = $('<div class="whisperspeech_generate_btn" title="Generate WhisperSpeech audio">' +
                '<i class="fa-solid fa-volume-high"></i>' +
                '</div>');
            
            // Insert at the beginning of the buttons container
            $(this).prepend(generateButton);
            console.log(`Added generate button to ${isUser ? 'user' : 'AI'} message (narrate_user: ${narrateUserEnabled})`);
        }
    });
}

// Function to split text into sentences
function splitIntoSentences(text) {
    // Split by common sentence endings, keeping the delimiter
    const sentences = text.match(/[^.!?]+[.!?]+/g) || [text];
    return sentences.map(s => s.trim()).filter(s => s.length > 0);
}

// Function to start a single audio generation request and collect task ID quickly
async function startSingleRequest(apiUrl, requestHeaders, requestBody, abortController, requestIndex, messageId) {
    try {
        console.log(`Starting request ${requestIndex + 1} for message ${messageId}`);
        
        const response = await fetch(apiUrl, {
            method: 'POST',
            headers: requestHeaders,
            body: requestBody,
            signal: abortController.signal
        });
        
        // Immediately extract and store task ID
        const taskId = response.headers.get('X-Task-ID');
        if (taskId) {
            const generationState = messageGenerationStates.get(messageId);
            if (generationState && !generationState.cancelled) {
                generationState.taskIds.push(taskId);
                console.log(`Collected task ID ${taskId} for request ${requestIndex + 1} of message ${messageId}`);
            }
        }
        
        // Check if generation was cancelled after getting task ID
        const generationState = messageGenerationStates.get(messageId);
        if (!generationState || generationState.cancelled) {
            console.log(`Request ${requestIndex + 1} cancelled after task ID collection`);
            // If we got a task ID but generation is cancelled, cancel it on server
            if (taskId) {
                try {
                    const url = extension_settings[extensionName].url;
                    await fetch(`${url}/cancel/${taskId}`, { method: 'POST' });
                    console.log(`Cancelled task ${taskId} on server immediately`);
                } catch (e) {
                    console.error(`Failed to cancel task ${taskId}:`, e);
                }
            }
            return { cancelled: true, taskId };
        }
        
        if (!response.ok) {
            throw new Error(`Server error: ${response.status}`);
        }
        
        const audioBlob = await response.blob();
        return { success: true, audioBlob, taskId, requestIndex };
        
    } catch (error) {
        if (error.name === 'AbortError') {
            console.log(`Request ${requestIndex + 1} was aborted`);
            return { cancelled: true };
        }
        console.error(`Request ${requestIndex + 1} failed:`, error);
        return { error: error.message, requestIndex };
    }
}

// Function to handle volume-high button clicks (clear queue and restart)
async function handleVolumeHighClick(event) {
    event.stopPropagation();
    event.preventDefault();
    
    // Check if extension is enabled
    if (!extension_settings[extensionName] || !extension_settings[extensionName].enabled) {
        return;
    }
    
    const button = $(event.currentTarget).closest('.whisperspeech_generate_btn');
    const messageContainer = button.closest('.mes');
    
    // Get or create unique message ID
    let messageId = messageContainer.attr('data-mes-id');
    if (!messageId) {
        messageId = 'msg_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
        messageContainer.attr('data-mes-id', messageId);
    }
    
    console.log(`Volume-high button clicked for message: ${messageId}`);
    
    // Clear queue and restart from this message
    clearQueueAndRestartFromMessage(messageId);
    
    // If the message doesn't have audio files yet, start generation
    const audioContainer = messageContainer.find('.whisperspeech_audio_container');
    const audioFiles = audioContainer.find('audio');
    
    if (audioFiles.length === 0 && !messageGenerationStates.has(messageId)) {
        // Start generation for this message
        handleGenerateClick({ currentTarget: button[0], stopPropagation: () => {}, preventDefault: () => {} });
    }
}

// Function to handle Generate button clicks
async function handleGenerateClick(event) {
    event.stopPropagation();
    event.preventDefault();
    
    // Check if extension is enabled
    if (!extension_settings[extensionName] || !extension_settings[extensionName].enabled) {
        return;
    }
    
    const button = $(event.currentTarget);
    const messageContainer = button.closest('.mes');
    
    // Get or create unique message ID
    let messageId = messageContainer.attr('data-mes-id');
    if (!messageId) {
        messageId = 'msg_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
        messageContainer.attr('data-mes-id', messageId);
    }
    
    // Check if generation is already in progress for this message
    if (messageGenerationStates.has(messageId)) {
        console.log(`Generation already in progress for message ${messageId}`);
        return;
    }
    
    // Check if this is a user message and if we should narrate it
    const isUser = isUserMessage(messageContainer);
    if (isUser && !extension_settings[extensionName].narrate_user) {
        console.log("User message narration is disabled - stopping generation");
        button.prop("disabled", false);
        button.html('<i class="fa-solid fa-volume-high"></i>');
        return;
    }
    
    console.log(`Starting generation for ${isUser ? 'user' : 'AI'} message`);
    
    const messageText = messageContainer.find('.mes_text').text().trim();
    
    if (!messageText) {
        console.log("No message text found");
        return;
    }
    
    // Get settings
    const url = extension_settings[extensionName].url;
    const language = extension_settings[extensionName].language;
    const speed = extension_settings[extensionName].speed;
    const model = extension_settings[extensionName].model;
    
    // Check URL
    if (!url || !isValidUrl(url)) {
        alert("Please configure a valid server URL in WhisperSpeech settings first.");
        return;
    }
    
    // Disable button and show loading state
    button.prop("disabled", true);
    button.html('<i class="fa-solid fa-spinner fa-spin"></i>');
    
    try {
        // Prepare text with language tag if needed
        let textToGenerate = messageText;
        
        // Check if we should only narrate quotes
        if (extension_settings[extensionName].quotes) {
            // Extract only quoted text
            const quotes = messageText.match(/"([^"]+)"/g);
            if (quotes) {
                // Remove the quotes themselves, keep only the content
                textToGenerate = quotes.map(q => q.slice(1, -1)).join(' ');
            } else {
                // No quotes found, skip generation
                button.prop("disabled", false);
                button.html('<i class="fa-solid fa-volume-high"></i>');
                console.log("No quotes found in message");
                return;
            }
        }
        
        // Prepare texts to generate (might be multiple if splitting sentences)
        let textsToGenerate = [];
        
        // Split quotes into sentences if both options are enabled
        if (extension_settings[extensionName].split_quotes && extension_settings[extensionName].quotes) {
            const sentences = splitIntoSentences(textToGenerate);
            textsToGenerate = sentences.map(sentence => language + sentence);
            console.log("Split into sentences:", sentences);
        } else {
            // Single text
            textsToGenerate = [language + textToGenerate];
        }
        
        console.log("Generating audio for:", textsToGenerate);
        
        // Initialize tracking for this message
        const generationState = {
            messageId: messageId,
            totalRequests: textsToGenerate.length,
            completedRequests: 0,
            cancelledRequests: 0,
            abortControllers: [],
            taskIds: [],
            cancelled: false
        };
        
        messageGenerationStates.set(messageId, generationState);
        messageAbortControllers.set(messageId, generationState.abortControllers);
        messageTaskIds.set(messageId, generationState.taskIds);
        
        // Create or get audio container for this message
        let audioContainer = messageContainer.find('.whisperspeech_audio_container');
        if (!audioContainer.length) {
            audioContainer = $('<div class="whisperspeech_audio_container" style="margin-top: 10px;"></div>');
            
            // Always add collapse/expand header (for both single and multiple audios)
            const header = $('<div class="whisperspeech_audio_header" style="cursor: pointer; padding: 10px 12px; margin-bottom: 10px; border-radius: 6px; display: flex; align-items: center; justify-content: space-between; background-color: var(--SmartThemeBlurTintColor); border: 1px solid var(--SmartThemeBorderColor);" title="Click to expand/collapse"></div>');
            const titleContainer = $('<div style="display: flex; align-items: center; gap: 8px;"></div>');
            const icon = $('<i class="fa-solid fa-music" style="opacity: 0.7;"></i>');
            
            // Set title based on number of files
            const titleText = textsToGenerate.length > 1 ? 'Generated Audio Files' : 'Generated Audio';
            const title = $(`<span style="font-weight: bold;">${titleText}</span>`);
            
            // Add cancel button
            const cancelButton = $('<div class="whisperspeech_cancel_btn menu_button" style="background-color: #dc3545; color: white; padding: 4px 8px; border-radius: 4px; font-size: 12px; cursor: pointer; margin-left: 10px;" title="Cancel generation">Cancel</div>');
            
            titleContainer.append(icon);
            titleContainer.append(title);
            titleContainer.append(cancelButton);
            
            const toggleIcon = $('<i class="fa-solid fa-chevron-down" style="transition: transform 0.3s;"></i>');
            header.append(titleContainer);
            header.append(toggleIcon);
            
            // Check if auto-hide is enabled
            const autoHide = extension_settings[extensionName].auto_hide_audio;
            const initialMaxHeight = autoHide ? '0' : '600px';
            const initialTransform = autoHide ? 'rotate(-90deg)' : 'rotate(0deg)';
            const initialCollapsed = autoHide ? 'collapsed' : '';
            
            const contentWrapper = $(`<div class="whisperspeech_audio_content ${initialCollapsed}" style="max-height: ${initialMaxHeight}; overflow-y: auto; overflow-x: hidden; transition: max-height 0.3s ease-out;"></div>`);
            
            // Set initial toggle icon state
            toggleIcon.css('transform', initialTransform);
            
            audioContainer.append(header);
            audioContainer.append(contentWrapper);
            
            // Toggle functionality
            header.on('click', function(e) {
                // Don't toggle if clicking on cancel button
                if ($(e.target).hasClass('whisperspeech_cancel_btn') || $(e.target).closest('.whisperspeech_cancel_btn').length) {
                    return;
                }
                
                const content = audioContainer.find('.whisperspeech_audio_content');
                const icon = $(this).find('i').last();
                
                if (content.hasClass('collapsed')) {
                    content.removeClass('collapsed');
                    content.css('max-height', '600px');
                    icon.css('transform', 'rotate(0deg)');
                } else {
                    content.addClass('collapsed');
                    content.css('max-height', '0');
                    icon.css('transform', 'rotate(-90deg)');
                }
            });
            
            // Cancel button functionality
            cancelButton.on('click', function(e) {
                e.stopPropagation();
                handleMessageCancel(messageId);
            });
            
            // Insert audio container BEFORE the message text (above it)
            messageContainer.find('.mes_text').before(audioContainer);
        }
        
        // Show cancel button
        audioContainer.find('.whisperspeech_cancel_btn').show();
        
        // Clear previous audio if exists
        const targetContainer = audioContainer.find('.whisperspeech_audio_content').length ? 
            audioContainer.find('.whisperspeech_audio_content') : audioContainer;
        
        targetContainer.find('audio').each(function() {
            const src = $(this).attr('src');
            if (src && src.startsWith('blob:')) {
                URL.revokeObjectURL(src);
            }
        });
        targetContainer.empty();
        
        // Prepare request data
        const apiUrl = `${url}/generate`;
        
        // Choose appropriate voice based on message type
        const isUser = isUserMessage(messageContainer);
        let voiceFileData, voiceFileType, voiceFileName;
        
        if (isUser) {
            // Use user voice for user messages
            voiceFileData = extension_settings[extensionName].user_voice_file_data;
            voiceFileType = extension_settings[extensionName].user_voice_file_type;
            voiceFileName = extension_settings[extensionName].user_voice_file;
        } else {
            // Use regular voice for AI messages
            voiceFileData = extension_settings[extensionName].voice_file_data;
            voiceFileType = extension_settings[extensionName].voice_file_type;
            voiceFileName = extension_settings[extensionName].voice_file;
        }
        
        // Function to check if generation should continue
        const shouldContinue = () => {
            const state = messageGenerationStates.get(messageId);
            return state && !state.cancelled;
        };
        
        // Start all requests sequentially to collect task IDs properly
        const audioPlayers = [];
        
        for (let i = 0; i < textsToGenerate.length; i++) {
            // Check if cancelled before starting each request
            if (!shouldContinue()) {
                console.log(`Generation cancelled before starting request ${i + 1}`);
                break;
            }
            
            const textWithLang = textsToGenerate[i];
            
            // Create abort controller for this request
            const abortController = new AbortController();
            generationState.abortControllers.push(abortController);
            
            // Prepare request body
            let requestBody;
            let requestHeaders = {};
            
            if (voiceFileData && voiceFileType) {
                const blob = base64ToBlob(voiceFileData, voiceFileType);
                requestBody = new FormData();
                requestBody.append('text', textWithLang);
                requestBody.append('speed', speed.toString());
                requestBody.append('format', 'mp3');
                requestBody.append('model', model);
                requestBody.append('voice', blob, voiceFileName || 'voice.wav');
            } else {
                requestHeaders['Content-Type'] = 'application/json';
                requestBody = JSON.stringify({
                    text: textWithLang,
                    speed: speed,
                    format: 'mp3',
                    model: model
                });
            }
            
            // Start the request and handle the response
            const result = await startSingleRequest(apiUrl, requestHeaders, requestBody, abortController, i, messageId);
            
            // Check if cancelled after request completion
            if (!shouldContinue()) {
                console.log(`Generation cancelled after request ${i + 1} completed`);
                break;
            }
            
            generationState.completedRequests++;
            
            if (result.cancelled) {
                console.log(`Request ${i + 1} was cancelled`);
                generationState.cancelledRequests++;
            } else if (result.success) {
                console.log(`Request ${i + 1} completed successfully`);
                
                // Create audio player
                const audioUrl = URL.createObjectURL(result.audioBlob);
                let audioPlayer;
                
                if (textsToGenerate.length > 1) {
                    const sentenceContainer = $('<div style="margin-bottom: 10px; padding: 8px; border-left: 3px solid var(--SmartThemeBorderColor); opacity: 0; transition: opacity 0.3s;"></div>');
                    const sentenceText = $('<div style="font-size: 0.9em; opacity: 0.8; margin-bottom: 5px;"></div>');
                    sentenceText.text(`Sentence ${result.requestIndex + 1}: "${textWithLang.replace(language, '')}"`);
                    sentenceContainer.append(sentenceText);
                    
                    audioPlayer = $('<audio controls style="width: 100%; max-width: 400px;"></audio>');
                    audioPlayer.attr('src', audioUrl);
                    audioPlayer.attr('data-index', result.requestIndex);
                    sentenceContainer.append(audioPlayer);
                    
                    targetContainer.append(sentenceContainer);
                    
                    // Fade in animation
                    setTimeout(() => {
                        sentenceContainer.css('opacity', '1');
                    }, 50);
                    
                    // Update header with count during generation
                    const header = audioContainer.find('.whisperspeech_audio_header');
                    if (header.length && shouldContinue()) {
                        const titleSpan = header.find('span').first();
                        const successCount = targetContainer.find('audio').length;
                        
                        if (textsToGenerate.length > 1) {
                            titleSpan.html(`Generated Audio Files <span style="opacity: 0.7;">(${successCount}/${textsToGenerate.length})</span>`);
                        } else {
                            titleSpan.html(`Generated Audio <span style="opacity: 0.7;">(Generating...)</span>`);
                        }
                    }
                } else {
                    // Single audio player - put it in the content wrapper
                    audioPlayer = $('<audio controls style="width: 100%; max-width: 400px;"></audio>');
                    audioPlayer.attr('src', audioUrl);
                    targetContainer.append(audioPlayer);
                }
                
                if (shouldContinue()) {
                    audioPlayers[result.requestIndex] = audioPlayer[0];
                    
                    // Update queue with newly available audio immediately (streaming approach)
                    if (extension_settings[extensionName].auto_generation) {
                        const messageTimestamp = getMessageTimestamp(messageContainer);
                        console.log(`Updating queue with audio ${result.requestIndex + 1} for message ${messageId}`);
                        updateAudioInQueue(messageId, audioPlayers, messageContainer, messageTimestamp);
                    }
                }
                
            } else if (result.error) {
                console.log(`Request ${i + 1} failed with error: ${result.error}`);
                
                // Create error placeholder
                if (shouldContinue()) {
                    const errorContainer = $('<div style="margin-bottom: 10px; padding: 8px; border-left: 3px solid #dc3545;"></div>');
                    const errorText = $('<div style="font-size: 0.9em; color: #dc3545; margin-bottom: 5px;"></div>');
                    
                    if (textsToGenerate.length > 1) {
                        errorText.text(`Sentence ${result.requestIndex + 1}: Generation failed`);
                    } else {
                        errorText.text(`Generation failed: ${result.error}`);
                    }
                    
                    errorContainer.append(errorText);
                    targetContainer.append(errorContainer);
                }
            }
            
            // Update button progress
            if (shouldContinue()) {
                const successCount = targetContainer.find('audio').length;
                
                if (generationState.completedRequests < textsToGenerate.length) {
                    if (textsToGenerate.length > 1) {
                        button.html(`<i class="fa-solid fa-spinner fa-spin"></i> ${successCount}/${textsToGenerate.length}`);
                    } else {
                        button.html(`<i class="fa-solid fa-spinner fa-spin"></i> Generating...`);
                    }
                }
            }
        }
        
        // Finish generation
        if (shouldContinue()) {
            const targetContainer = audioContainer.find('.whisperspeech_audio_content').length ? 
                audioContainer.find('.whisperspeech_audio_content') : audioContainer;
            const successCount = targetContainer.find('audio').length;
            
            // Hide cancel button
            audioContainer.find('.whisperspeech_cancel_btn').hide();
            button.prop("disabled", false);
            
            if (successCount === 0) {
                button.html('<i class="fa-solid fa-exclamation-triangle" style="color: #dc3545;"></i>');
            } else if (successCount < textsToGenerate.length) {
                button.html('<i class="fa-solid fa-check-circle" style="color: #ffc107;"></i>');
            } else {
                button.html('<i class="fa-solid fa-check" style="color: #28a745;"></i>');
            }
            
            setTimeout(() => {
                button.html('<i class="fa-solid fa-volume-high"></i>');
            }, 2000);
            
            // Update final header
            const header = audioContainer.find('.whisperspeech_audio_header');
            if (header.length) {
                const titleSpan = header.find('span').first();
                const errorCount = generationState.completedRequests - successCount;
                
                if (textsToGenerate.length > 1) {
                    // Multiple files
                    if (errorCount > 0) {
                        titleSpan.html(`Generated Audio Files <span style="opacity: 0.7;">(${successCount}/${textsToGenerate.length})</span> <span style="color: #dc3545; font-size: 0.9em;">${errorCount} failed</span>`);
                    } else {
                        titleSpan.html(`Generated Audio Files <span style="opacity: 0.7;">(${successCount})</span>`);
                    }
                } else {
                    // Single file
                    if (errorCount > 0) {
                        titleSpan.html(`Generated Audio <span style="color: #dc3545; font-size: 0.9em;">Generation failed</span>`);
                    } else {
                        titleSpan.html(`Generated Audio <span style="opacity: 0.7;">(Ready)</span>`);
                    }
                }
            }
            
            // Add to global audio queue for auto-play if needed
            if (extension_settings[extensionName].auto_generation && audioPlayers.length > 0) {
                const messageTimestamp = getMessageTimestamp(messageContainer);
                addToAudioQueue(messageId, audioPlayers, messageContainer, messageTimestamp);
            }
        }
        
        // Clean up tracking
        messageGenerationStates.delete(messageId);
        messageAbortControllers.delete(messageId);
        messageTaskIds.delete(messageId);
        
        // Check if there are any messages in queue waiting for this generation to finish
        if (globalAudioQueue.length > 0 && !isPlayingQueue) {
            console.log("Generation failed, checking if queue can be processed");
            // Small delay to ensure cleanup is complete
            setTimeout(() => {
                processAudioQueue();
            }, 100);
        }
        
        // Check if there are any messages in queue waiting for this generation to finish
        if (globalAudioQueue.length > 0 && !isPlayingQueue) {
            console.log("Generation finished, checking if queue can be processed");
            // Small delay to ensure cleanup is complete
            setTimeout(() => {
                processAudioQueue();
            }, 100);
        }
        
    } catch (error) {
        console.error("Audio generation setup error:", error);
        // Error state
        button.html('<i class="fa-solid fa-exclamation-triangle" style="color: #dc3545;"></i>');
        button.prop("disabled", false);
        setTimeout(() => {
            button.html('<i class="fa-solid fa-volume-high"></i>');
        }, 2000);
        
        // Clean up tracking
        messageGenerationStates.delete(messageId);
        messageAbortControllers.delete(messageId);
        messageTaskIds.delete(messageId);
    }
}

// Updated shouldAutoGenerate function with additional logging
function shouldAutoGenerate(messageContainer) {
    // Check if extension and auto-generation are enabled
    if (!extension_settings[extensionName] || 
        !extension_settings[extensionName].enabled || 
        !extension_settings[extensionName].auto_generate_audio) {
        console.log("Auto-generation disabled or extension not enabled");
        return false;
    }
    
    const isUser = isUserMessage(messageContainer);
    const narrateUserSetting = extension_settings[extensionName].narrate_user;
    
    console.log(`Message type: ${isUser ? 'user' : 'AI'}, narrate_user setting: ${narrateUserSetting}`);
    
    // For user messages, check if narrate_user is enabled
    if (isUser) {
        const shouldNarrate = narrateUserSetting === true;
        console.log(`User message narration setting: ${shouldNarrate} (raw value: ${narrateUserSetting})`);
        return shouldNarrate;
    }
    
    // For AI messages ({{char}}), always auto-generate if auto_generate_audio is enabled
    console.log("AI message - auto-generation enabled");
    return true;
}

// Function to check if message already has audio or generation in progress
function messageHasAudioOrGeneration(messageContainer) {
    const messageId = messageContainer.attr('data-mes-id');
    
    // Check if generation is in progress
    if (messageId && messageGenerationStates.has(messageId)) {
        return true;
    }
    
    // Check if audio container already exists
    const audioContainer = messageContainer.find('.whisperspeech_audio_container');
    if (audioContainer.length > 0) {
        // Check if it has actual audio files or is just cancelled/error state
        const hasAudio = audioContainer.find('audio').length > 0;
        if (hasAudio) {
            return true;
        }
    }
    
    return false;
}

// Function to handle auto-generation for new messages
function handleAutoGeneration(messageType = null) {
    if (!extension_settings[extensionName] || 
        !extension_settings[extensionName].enabled || 
        !extension_settings[extensionName].auto_generate_audio) {
        console.log("Auto-generation disabled in settings");
        return;
    }
    
    console.log(`Checking for auto-generation opportunities (message type: ${messageType})...`);
    
    // Find only the very last message
    const allMessages = $(".mes");
    if (allMessages.length === 0) {
        console.log("No messages found");
        return;
    }
    
    const lastMessage = allMessages.last();
    const isUser = isUserMessage(lastMessage);
    
    console.log(`Last message is ${isUser ? 'user' : 'AI'} message, classes: "${lastMessage.attr('class')}"`);
    
    // Additional check: if we're handling a MESSAGE_SENT event, make sure we're processing a user message
    if (messageType === 'user' && !isUser) {
        console.log("MESSAGE_SENT event but last message is not a user message - skipping");
        return;
    }
    
    // Additional check: if we're handling a MESSAGE_RECEIVED event, make sure we're processing an AI message
    if (messageType === 'ai' && isUser) {
        console.log("MESSAGE_RECEIVED event but last message is a user message - skipping");
        return;
    }
    
    // Skip if this message shouldn't have auto-generation
    if (!shouldAutoGenerate(lastMessage)) {
        console.log("Auto-generation skipped based on shouldAutoGenerate()");
        return;
    }
    
    // Skip if message already has audio or generation in progress
    if (messageHasAudioOrGeneration(lastMessage)) {
        console.log("Message already has audio or generation in progress");
        return;
    }
    
    // Skip if message has no text content
    const messageText = lastMessage.find('.mes_text').text().trim();
    if (!messageText) {
        console.log("Message has no text content");
        return;
    }
    
    console.log(`Auto-generating audio for the latest ${isUser ? 'user' : 'AI'} message`);
    
    // Find the generate button and trigger it
    const generateButton = lastMessage.find('.whisperspeech_generate_btn');
    if (generateButton.length > 0) {
        console.log("Found generate button, triggering click");
        // Small delay to avoid conflicts with UI updates
        setTimeout(() => {
            generateButton.trigger('click');
        }, 500);
    } else {
        console.log("No generate button found for message");
    }
}

function initializeChatObserver() {
    // Add pause/resume button to chat interface
    addQueueControlButton();
    
    // Initial button addition only if enabled
    if (extension_settings[extensionName] && extension_settings[extensionName].enabled) {
        addGenerateButtons();
    }
    
    // Create observer for new messages
    const chatObserver = new MutationObserver(function(mutations) {
        mutations.forEach(function(mutation) {
            if (mutation.type === 'childList' && extension_settings[extensionName] && extension_settings[extensionName].enabled) {
                addGenerateButtons();
            }
        });
    });
    
    // Start observing the chat container
    const chatContainer = document.querySelector("#chat");
    if (chatContainer) {
        chatObserver.observe(chatContainer, {
            childList: true,
            subtree: true
        });
    }
}

// Add pause/resume button to chat interface
function addQueueControlButton() {
    // Check if button already exists
    if (document.querySelector('.whisperspeech_queue_control')) {
        return;
    }
    
    // Find the options button
    const optionsButton = document.querySelector('#options_button');
    
    if (!optionsButton) {
        console.log("Could not find options button to add queue control button next to");
        return;
    }
    
    // Create the button
    const queueButton = document.createElement('div');
    queueButton.className = 'whisperspeech_queue_control fa-solid fa-play interactable';
    queueButton.id = 'whisperspeech_queue_button';
    queueButton.title = 'No audio playing';
    queueButton.tabIndex = 0;
    
    // Add click handler
    queueButton.addEventListener('click', function() {
        if (!extension_settings[extensionName] || !extension_settings[extensionName].enabled) {
            return;
        }
        toggleAudioQueue();
    });
    
    // Add keyboard support
    queueButton.addEventListener('keydown', function(e) {
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            this.click();
        }
    });
    
    // Insert the button right after the options button
    optionsButton.parentNode.insertBefore(queueButton, optionsButton.nextSibling);
    
    console.log("Added queue control button next to options button");
}

// Function to handle message generation cancellation
async function handleMessageCancel(messageId) {
    console.log(`Cancelling generation for message: ${messageId}`);
    
    // Get generation state
    const generationState = messageGenerationStates.get(messageId);
    if (!generationState) {
        console.log(`No generation state found for message ${messageId}`);
        return;
    }
    
    // Mark as cancelled FIRST - this stops new requests from starting
    generationState.cancelled = true;
    
    // Remove from audio queue
    removeFromAudioQueue(messageId);
    
    // Cancel current requests
    const abortControllers = generationState.abortControllers;
    if (abortControllers && abortControllers.length > 0) {
        let cancelledCount = 0;
        abortControllers.forEach((controller, index) => {
            if (controller && !controller.signal.aborted) {
                controller.abort();
                cancelledCount++;
                console.log(`Aborted request ${index + 1} for message ${messageId}`);
            }
        });
        console.log(`Aborted ${cancelledCount} active requests for message ${messageId}`);
    }

    // Cancel tasks on server
    const taskIds = generationState.taskIds;
    if (taskIds && taskIds.length > 0) {
        console.log(`Cancelling ${taskIds.length} server tasks for message ${messageId}`);
        try {
            const url = extension_settings[extensionName].url;
            const cancelPromises = taskIds.map(async (taskId, index) => {
                try {
                    const response = await fetch(`${url}/cancel/${taskId}`, { method: 'POST' });
                    if (response.ok) {
                        console.log(`Successfully cancelled server task ${taskId} (${index + 1}/${taskIds.length})`);
                    } else {
                        console.error(`Failed to cancel server task ${taskId}: ${response.status}`);
                    }
                } catch (e) {
                    console.error(`Error cancelling server task ${taskId}:`, e);
                }
            });
            
            await Promise.allSettled(cancelPromises);
            console.log(`All server cancellation requests completed for message ${messageId}`);
        } catch (error) {
            console.error('Error sending cancel requests:', error);
        }
    } else {
        console.log(`No server task IDs to cancel for message ${messageId}`);
    }

    // Find message container and update UI
    const messageContainer = $(`.mes[data-mes-id="${messageId}"]`);
    if (messageContainer.length) {
        const generateButton = messageContainer.find('.whisperspeech_generate_btn');
        const audioContainer = messageContainer.find('.whisperspeech_audio_container');
        const cancelButton = audioContainer.find('.whisperspeech_cancel_btn');
        
        // Reset generate button
        generateButton.prop("disabled", false);
        generateButton.html('<i class="fa-solid fa-volume-high"></i>');
        
        // Hide cancel button
        cancelButton.hide();
        
        // Update header to show cancellation
        const header = audioContainer.find('.whisperspeech_audio_header');
        if (header.length) {
            const titleSpan = header.find('span').first();
            const targetContainer = audioContainer.find('.whisperspeech_audio_content').length ? 
                audioContainer.find('.whisperspeech_audio_content') : audioContainer;
            const successCount = targetContainer.find('audio').length;
            
            if (successCount > 0) {
                titleSpan.html(`Generated Audio Files <span style="opacity: 0.7;">(${successCount})</span> <span style="color: #ffc107;">(Cancelled)</span>`);
            } else {
                titleSpan.html('Generated Audio Files <span style="color: #ffc107;">(Cancelled)</span>');
            }
        }
        
        // Show cancellation message if no audio was generated
        const targetContainer = audioContainer.find('.whisperspeech_audio_content').length ? 
            audioContainer.find('.whisperspeech_audio_content') : audioContainer;
        
        if (targetContainer.children().length === 0) {
            targetContainer.append('<div style="padding: 10px; color: #ffc107; text-align: center;">Generation cancelled by user</div>');
        }
    }

    // Clean up tracking immediately
    messageGenerationStates.delete(messageId);
    messageAbortControllers.delete(messageId);
    messageTaskIds.delete(messageId);
    
    console.log(`Cleanup completed for message ${messageId}`);
    
    // Check if there are any messages in queue waiting for this generation to finish
    if (globalAudioQueue.length > 0 && !isPlayingQueue) {
        console.log("Generation cancelled, checking if queue can be processed");
        // Small delay to ensure cleanup is complete
        setTimeout(() => {
            processAudioQueue();
        }, 100);
    }
}

async function handleTestCancel() {
    // Cancel current request
    if (testAbortController) {
        testAbortController.abort();
        console.log("Test generation aborted by user");
    }

    // Cancel task on server if we have task ID
    if (currentTestTaskId) {
        try {
            const url = $("#whisperspeech_webui_url").val().trim();
            const cancelUrl = `${url}/cancel/${currentTestTaskId}`;
            
            await fetch(cancelUrl, { method: 'POST' });
            console.log("Cancel request sent to server");
        } catch (error) {
            console.error('Error sending cancel request:', error);
        }
    }

    // Reset UI state
    const testBtn = $("#whisperspeech_test_btn");
    const testCancelBtn = $("#whisperspeech_test_cancel_btn");
    const statusDiv = $("#whisperspeech_test_status");
    const audioDiv = $("#whisperspeech_test_audio");

    testBtn.prop("disabled", false);
    testBtn.text("Test");
    testCancelBtn.hide();
    
    statusDiv.show();
    statusDiv.html('<span style="color: #ffc107;">Test cancelled</span>');
    audioDiv.hide();

    // Clean up
    testAbortController = null;
    currentTestTaskId = null;

    // Hide status after 3 seconds
    setTimeout(() => {
        statusDiv.fadeOut();
    }, 3000);
}

// The main function of jQuery
jQuery(async () => {
    // Loading settings
    loadSettings();
    
    // Adding HTML to the extension panel
    const settingsHtml = getHtml();
    $("#extensions_settings").append(settingsHtml);
    
    //Initialization of drawer toggle
    $("#extensions_settings .inline-drawer-toggle").on("click", function () {
        $(this).closest(".inline-drawer").toggleClass("open");
        $(this).find(".inline-drawer-icon").toggleClass("down up");
    });
    
    // Loading values from settings
    $("#whisperspeech_webui_url").val(extension_settings[extensionName].url || "http://127.0.0.1:5050");
    $("#whisperspeech_language").val(extension_settings[extensionName].language || "<en>");
    $("#whisperspeech_model").val(extension_settings[extensionName].model || "tiny");
    $("#whisperspeech_enable").prop("checked", extension_settings[extensionName].enabled);
    $("#whisperspeech_narrate_user").prop("checked", extension_settings[extensionName].narrate_user);
    $("#whisperspeech_auto_generation").prop("checked", extension_settings[extensionName].auto_generation);
    $("#whisperspeech_auto_generate_audio").prop("checked", extension_settings[extensionName].auto_generate_audio ?? false);
    $("#whisperspeech_quotes").prop("checked", extension_settings[extensionName].quotes);
    $("#whisperspeech_split_quotes").prop("checked", extension_settings[extensionName].split_quotes);
    $("#whisperspeech_auto_hide_audio").prop("checked", extension_settings[extensionName].auto_hide_audio ?? false); // default false
    $("#whisperspeech_speed_bar").val(extension_settings[extensionName].speed || 13.5);
    $("#whisperspeech_speed").text(extension_settings[extensionName].speed || 13.5);
    
    // Set initial test message based on loaded language
    updateTestMessage(extension_settings[extensionName].language || "<en>");
    
    // Load saved voice file if exists
    let uploadedAudio = loadSavedVoiceFile();
    let uploadedUserAudio = loadSavedUserVoiceFile();
    
    // Handling changes to form fields
    $("#whisperspeech_webui_url").on("input", function() {
        const url = $(this).val().trim();
        extension_settings[extensionName].url = url;
        $("#whisperspeech_connection_status").hide(); // Hide status when URL changes
        
        // Basic URL validation styling
        if (url && !isValidUrl(url)) {
            $(this).css("border-color", "#dc3545");
        } else {
            $(this).css("border-color", "");
        }
        
        saveSettings();
    });
    
    $("#whisperspeech_language").on("change", function() {
        const selectedLanguage = $(this).val();
        extension_settings[extensionName].language = selectedLanguage;
        updateTestMessage(selectedLanguage);
        // Hide test audio when language changes
        $("#whisperspeech_test_audio").hide();
        $("#whisperspeech_test_status").hide();
        saveSettings();
    });
    
    $("#whisperspeech_model").on("change", function() {
        extension_settings[extensionName].model = $(this).val();
        // Hide test audio when model changes
        $("#whisperspeech_test_audio").hide();
        $("#whisperspeech_test_status").hide();
        saveSettings();
    });
    
    $("#whisperspeech_enable").on("change", function() {
        extension_settings[extensionName].enabled = $(this).prop("checked");
        saveSettings();
        
        // Add or remove Generate buttons based on enabled state
        if (extension_settings[extensionName].enabled) {
            addGenerateButtons();
        } else {
            $(".whisperspeech_generate_btn").remove();
        }
    });
    
    // Enhanced narrate_user setting change handler
    $("#whisperspeech_narrate_user").on("change", function() {
        const isChecked = $(this).prop("checked");
        extension_settings[extensionName].narrate_user = isChecked;
        console.log(`Narrate user messages changed to: ${isChecked} (type: ${typeof isChecked})`);
        saveSettings();
        
        // Update buttons based on new setting
        addGenerateButtons();
        
        // If unchecked, remove any ongoing audio generation for user messages
        if (!isChecked) {
            console.log("Narrate user disabled - checking for user message generations to cancel");
            const allMessages = $('.mes');
            allMessages.each(function() {
                const messageContainer = $(this);
                const isUser = isUserMessage(messageContainer);
                const messageId = messageContainer.attr('data-mes-id');
                
                if (isUser && messageId && messageGenerationStates.has(messageId)) {
                    console.log(`Cancelling generation for user message ${messageId}`);
                    handleMessageCancel(messageId);
                }
            });
            
            // Also remove user messages from audio queue
            globalAudioQueue = globalAudioQueue.filter(item => {
                const messageContainer = item.messageContainer;
                const isUser = isUserMessage(messageContainer);
                if (isUser) {
                    console.log(`Removing user message ${item.messageId} from audio queue`);
                    return false;
                }
                return true;
            });
        } else {
            console.log("Narrate user enabled - will add buttons to user messages");
        }
    });
    
    $("#whisperspeech_auto_generation").on("change", function() {
        extension_settings[extensionName].auto_generation = $(this).prop("checked");
        saveSettings();
    });
    
    $("#whisperspeech_auto_generate_audio").on("change", function() {
        extension_settings[extensionName].auto_generate_audio = $(this).prop("checked");
        saveSettings();
    });
    
    $("#whisperspeech_quotes").on("change", function() {
        extension_settings[extensionName].quotes = $(this).prop("checked");
        saveSettings();
    });
    
    $("#whisperspeech_split_quotes").on("change", function() {
        extension_settings[extensionName].split_quotes = $(this).prop("checked");
        saveSettings();
    });
    
    $("#whisperspeech_auto_hide_audio").on("change", function() {
        extension_settings[extensionName].auto_hide_audio = $(this).prop("checked");
        saveSettings();
    });
    
    $("#whisperspeech_speed_bar").on("input", function() {
        const value = parseFloat($(this).val());
        extension_settings[extensionName].speed = value;
        $("#whisperspeech_speed").text(value);
        // Hide test audio when speed changes
        $("#whisperspeech_test_audio").hide();
        $("#whisperspeech_test_status").hide();
        saveSettings();
    });
    
    // Handle Connect button click
    $("#whisperspeech_connect_btn").on("click", async function() {
        const url = $("#whisperspeech_webui_url").val().trim();
        const statusDiv = $("#whisperspeech_connection_status");
        const connectBtn = $(this);
        
        // Validate URL first
        if (!url || !isValidUrl(url)) {
            statusDiv.show();
            statusDiv.html('<span style="color: #dc3545;">✗ Please enter a valid URL (e.g., http://127.0.0.1:5050)</span>');
            return;
        }
        
        // Disable button during connection test
        connectBtn.prop("disabled", true);
        connectBtn.text("Connecting...");
        
        // Show status
        statusDiv.show();
        statusDiv.html('Testing connection...');
        
        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 5000); // 5 second timeout
            
            // Try to fetch the base URL
            const response = await fetch(url, {
                method: 'GET',
                signal: controller.signal,
                headers: {
                    'Accept': 'text/html,application/json'
                }
            });
            
            clearTimeout(timeoutId);
            
            // Any response (even error codes) means server is reachable
            statusDiv.html('<span style="color: #28a745;">✓ Server found! Connection successful.</span>');
            
            // Save successful connection details
            extension_settings[extensionName].url = url;
            saveSettings();
            
        } catch (error) {
            console.error("Connection error:", error);
            
            if (error.name === 'AbortError') {
                statusDiv.html('<span style="color: #dc3545;">✗ Connection timeout. Server not responding.</span>');
            } else if (error.message.includes('Failed to fetch')) {
                // This could be CORS or network error
                // Try to give more helpful message
                statusDiv.html('<span style="color: #dc3545;">✗ Cannot connect to server. Please check:<br>• URL is correct and complete<br>• WhisperSpeech server is running<br>• No firewall blocking the connection</span>');
            } else {
                statusDiv.html('<span style="color: #dc3545;">✗ Connection failed: ' + error.message + '</span>');
            }
        } finally {
            // Re-enable button
            connectBtn.prop("disabled", false);
            connectBtn.text("Test");
        }
    });
    
    // Handle file upload and show play button
    $("#whisperspeech_voice_file").on("change", async function(e) {
        const file = e.target.files[0];
        if (file) {
            // Clean up previous audio URL if exists
            if (uploadedAudio) {
                URL.revokeObjectURL(uploadedAudio);
            }
            
            uploadedAudio = URL.createObjectURL(file);
            $("#whisperspeech_audio_player").attr("src", uploadedAudio);
            $("#whisperspeech_voice_controls").show();
            $("#whisperspeech_clear_voice").css("display", "inline-block");
            
            // Hide test audio when voice changes
            $("#whisperspeech_test_audio").hide();
            $("#whisperspeech_test_status").hide();
            
            // Convert file to base64 and save
            try {
                const base64Data = await fileToBase64(file);
                extension_settings[extensionName].voice_file = file.name;
                extension_settings[extensionName].voice_file_data = base64Data;
                extension_settings[extensionName].voice_file_type = file.type;
                saveSettings();
            } catch (error) {
                console.error("Error saving voice file:", error);
            }
        }
    });
    
    // Handle clear button click
    $("#whisperspeech_clear_voice").on("click", function() {
        if (uploadedAudio) {
            URL.revokeObjectURL(uploadedAudio);
            uploadedAudio = null;
        }
        $("#whisperspeech_voice_file").val("");
        $("#whisperspeech_audio_player").attr("src", "");
        $("#whisperspeech_voice_controls").hide();
        $("#whisperspeech_clear_voice").hide();
        
        // Hide test audio when voice is cleared
        $("#whisperspeech_test_audio").hide();
        $("#whisperspeech_test_status").hide();
        
        // Clear all voice data from settings
        extension_settings[extensionName].voice_file = null;
        extension_settings[extensionName].voice_file_data = null;
        extension_settings[extensionName].voice_file_type = null;
        saveSettings();
    });
    
    // Handle user voice file upload
    $("#whisperspeech_user_voice_file").on("change", async function(e) {
        const file = e.target.files[0];
        if (file) {
            // Clean up previous audio URL if exists
            if (uploadedUserAudio) {
                URL.revokeObjectURL(uploadedUserAudio);
            }
            
            uploadedUserAudio = URL.createObjectURL(file);
            $("#whisperspeech_user_audio_player").attr("src", uploadedUserAudio);
            $("#whisperspeech_user_voice_controls").show();
            $("#whisperspeech_clear_user_voice").css("display", "inline-block");
            
            // Hide test audio when voice changes
            $("#whisperspeech_test_audio").hide();
            $("#whisperspeech_test_status").hide();
            
            // Convert file to base64 and save
            try {
                const base64Data = await fileToBase64(file);
                extension_settings[extensionName].user_voice_file = file.name;
                extension_settings[extensionName].user_voice_file_data = base64Data;
                extension_settings[extensionName].user_voice_file_type = file.type;
                saveSettings();
            } catch (error) {
                console.error("Error saving user voice file:", error);
            }
        }
    });
    
    // Handle clear user voice button click
    $("#whisperspeech_clear_user_voice").on("click", function() {
        if (uploadedUserAudio) {
            URL.revokeObjectURL(uploadedUserAudio);
            uploadedUserAudio = null;
        }
        $("#whisperspeech_user_voice_file").val("");
        $("#whisperspeech_user_audio_player").attr("src", "");
        $("#whisperspeech_user_voice_controls").hide();
        $("#whisperspeech_clear_user_voice").hide();
        
        // Hide test audio when voice is cleared
        $("#whisperspeech_test_audio").hide();
        $("#whisperspeech_test_status").hide();
        
        // Clear all user voice data from settings
        extension_settings[extensionName].user_voice_file = null;
        extension_settings[extensionName].user_voice_file_data = null;
        extension_settings[extensionName].user_voice_file_type = null;
        saveSettings();
    });
    
    // Handle test message input change
    $("#whisperspeech_test_message").on("input", function() {
        // Hide test audio when message changes
        $("#whisperspeech_test_audio").hide();
        $("#whisperspeech_test_status").hide();
    });
    
    // Handle Test Cancel button click
    $("#whisperspeech_test_cancel_btn").on("click", handleTestCancel);
    
    // Handle Test button click
    $("#whisperspeech_test_btn").on("click", async function() {
        // Check if extension is enabled
        if (!extension_settings[extensionName].enabled) {
            const statusDiv = $("#whisperspeech_test_status");
            statusDiv.show();
            statusDiv.html('<span style="color: #dc3545;">Please enable WhisperSpeech first.</span>');
            return;
        }
        
        const url = $("#whisperspeech_webui_url").val().trim();
        const testMessage = $("#whisperspeech_test_message").val();
        const language = $("#whisperspeech_language").val();
        const speed = parseFloat($("#whisperspeech_speed_bar").val());
        const model = $("#whisperspeech_model").val();
        const statusDiv = $("#whisperspeech_test_status");
        const audioDiv = $("#whisperspeech_test_audio");
        const audioPlayer = $("#whisperspeech_test_player");
        const testBtn = $(this);
        const testCancelBtn = $("#whisperspeech_test_cancel_btn");
        
        console.log("Test parameters:", { language, speed, model });
        
        // Prepare text with language tag
        const textWithLang = language + testMessage;
        
        // Check if URL is valid
        if (!url || !isValidUrl(url)) {
            statusDiv.show();
            statusDiv.html('<span style="color: #dc3545;">Please set a valid server URL first.</span>');
            return;
        }
        
        // Create abort controller for cancellation
        testAbortController = new AbortController();
        
        // Update UI for test state
        testBtn.prop("disabled", true);
        testBtn.text("Generating...");
        testCancelBtn.show();
        
        // Show status
        statusDiv.show();
        // Check if we have a voice file (use regular voice for test)
        const voiceFileData = extension_settings[extensionName].voice_file_data;
        const voiceFileType = extension_settings[extensionName].voice_file_type;
        const voiceFileName = extension_settings[extensionName].voice_file;
        
        if (voiceFileData && voiceFileType) {
            statusDiv.html(`Generating audio with ${model} model and voice: ${voiceFileName}...`);
        } else {
            statusDiv.html(`Generating audio with ${model} model...`);
        }
        
        // Hide previous audio player
        audioDiv.hide();
        
        try {
            const apiUrl = `${url}/generate`;
            
            // Check if we have a voice file
            const voiceFileData = extension_settings[extensionName].voice_file_data;
            const voiceFileType = extension_settings[extensionName].voice_file_type;
            const voiceFileName = extension_settings[extensionName].voice_file;
            
            let requestBody;
            let requestHeaders = {};
            
            if (voiceFileData && voiceFileType) {
                // Convert base64 back to blob for upload
                const blob = base64ToBlob(voiceFileData, voiceFileType);
                
                // Use FormData for file upload
                requestBody = new FormData();
                requestBody.append('text', textWithLang);
                requestBody.append('speed', speed.toString());
                requestBody.append('format', 'mp3');
                requestBody.append('model', model);
                requestBody.append('voice', blob, voiceFileName || 'voice.wav');
                
                console.log("Sending multipart request with model:", model);
            } else {
                // Use JSON for text-only request
                requestHeaders['Content-Type'] = 'application/json';
                requestBody = JSON.stringify({
                    text: textWithLang,
                    speed: speed,
                    format: 'mp3',
                    model: model
                });
                
                console.log("Sending JSON request:", JSON.parse(requestBody));
            }
            
            const response = await fetch(apiUrl, {
                method: 'POST',
                headers: requestHeaders,
                body: requestBody,
                signal: testAbortController.signal
            });
            
            // Extract task ID from response headers
            currentTestTaskId = response.headers.get('X-Task-ID');
            
            if (response.ok) {
                const audioBlob = await response.blob();
                const audioUrl = URL.createObjectURL(audioBlob);
                
                // Clean up previous audio URL if exists
                const oldSrc = audioPlayer.attr("src");
                if (oldSrc && oldSrc.startsWith("blob:")) {
                    URL.revokeObjectURL(oldSrc);
                }
                
                // Set new audio and show player
                audioPlayer.attr("src", audioUrl);
                audioDiv.show();
                
                // Only auto-play if "Auto-play generated audio" is enabled
                if (extension_settings[extensionName].auto_generation) {
                    audioPlayer[0].play().catch(e => {
                        console.log("Auto-play was prevented:", e);
                    });
                }
                
                statusDiv.html('<span style="color: #28a745;">✓ Audio generated successfully!</span>');
                
                // Hide status after 3 seconds
                setTimeout(() => {
                    statusDiv.fadeOut();
                }, 3000);
                
                // Log successful generation
                console.log("Audio generated successfully with model:", model);
                
            } else if (response.status === 499) {
                // Task was cancelled
                const errorData = await response.json();
                statusDiv.html(`<span style="color: #ffc107;">Generation cancelled: ${errorData.error || 'Unknown error'}</span>`);
                audioDiv.hide();
            } else {
                const errorText = await response.text();
                throw new Error(`Server error: ${response.status} - ${errorText}`);
            }
            
        } catch (error) {
            console.error("Test generation error:", error);
            
            if (error.name === 'AbortError') {
                statusDiv.html('<span style="color: #ffc107;">Generation cancelled by user</span>');
            } else {
                statusDiv.html(`<span style="color: #dc3545;">✗ Error: ${error.message}</span>`);
            }
            
            audioDiv.hide();
        } finally {
            // Reset UI state
            testBtn.prop("disabled", false);
            testBtn.text("Test");
            testCancelBtn.hide();
            
            // Clean up
            testAbortController = null;
            currentTestTaskId = null;
        }
    });
    
    // Logging into the console after loading
    console.log("WhisperSpeech web UI extension loaded successfully!");
    
    // Initialize chat observer for Generate buttons
    initializeChatObserver();
    
    // Add event delegation for Generate button clicks
    $(document).on("click", ".whisperspeech_generate_btn", handleGenerateClick);
    
    // Add event delegation for Generate button clicks with clear queue functionality
    $(document).on("click", ".whisperspeech_generate_btn i.fa-volume-high", handleVolumeHighClick);
    
    // Add event delegation for swipe left/right buttons (message variants)
    $(document).on("click", ".swipe_left, .swipe_right", function(e) {
        const swipeDirection = $(this).hasClass('swipe_left') ? 'left' : 'right';
        console.log(`Swipe action detected: ${swipeDirection}`);
        
        // Find the message container that contains this swipe button
        const messageContainer = $(this).closest('.mes');
        
        if (messageContainer.length) {
            // Small delay to allow the content to change before handling
            setTimeout(() => {
                handleMessageVariantSwitch(messageContainer, swipeDirection);
            }, 100);
        }
    });
    
    // Handle Regenerate button clicks to cancel ongoing generation
    $(document).on("click", "#option_regenerate", function() {
        console.log("Regenerate clicked - checking for ongoing audio generation");
        
        // Find the last message with ongoing generation
        let lastMessageId = null;
        let lastTimestamp = 0;
        
        for (const [messageId, generationState] of messageGenerationStates.entries()) {
            if (generationState && !generationState.cancelled) {
                // Extract timestamp from messageId (assuming format like 'msg_timestamp_random')
                const parts = messageId.split('_');
                if (parts.length >= 2) {
                    const timestamp = parseInt(parts[1]);
                    if (timestamp > lastTimestamp) {
                        lastTimestamp = timestamp;
                        lastMessageId = messageId;
                    }
                }
            }
        }
        
        // If no messageId with timestamp found, try to find the last assistant message with generation
        if (!lastMessageId) {
            // Find the last assistant message that might have ongoing generation
            const assistantMessages = $('.mes:not(.mes_user)').toArray().reverse();
            
            for (const messageEl of assistantMessages) {
                const $messageEl = $(messageEl);
                const messageId = $messageEl.attr('data-mes-id');
                
                if (messageId && messageGenerationStates.has(messageId)) {
                    const generationState = messageGenerationStates.get(messageId);
                    if (generationState && !generationState.cancelled) {
                        lastMessageId = messageId;
                        break;
                    }
                }
            }
        }
        
        // Cancel the ongoing generation if found
        if (lastMessageId) {
            console.log(`Cancelling ongoing audio generation for message: ${lastMessageId}`);
            handleMessageCancel(lastMessageId);
        } else {
            console.log("No ongoing audio generation found to cancel");
        }
        
        // Clear audio queue as well
        globalAudioQueue = [];
        isPlayingQueue = false;
        currentlyPlayingMessage = null;
        currentMessageAudioIndex = 0;
        isPaused = false;
        pausedAudioElement = null;
        pausedPosition = 0;
        updateQueueControlButton();
        console.log("Cleared global audio queue");
    });
    
    // Optional: listening for events
    eventSource.on(event_types.APP_READY, () => {
        console.log("WhisperSpeech web UI extension: Ready!");
        // Re-initialize in case chat wasn't ready
        initializeChatObserver();
    });
    
    // Updated event listeners with explicit message type parameters
    // Listen for new messages to add buttons and handle auto-generation
    eventSource.on(event_types.MESSAGE_RECEIVED, () => {
        if (extension_settings[extensionName] && extension_settings[extensionName].enabled) {
            console.log("MESSAGE_RECEIVED event - adding buttons and checking auto-generation for AI message");
            addGenerateButtons();
            // Delay auto-generation to ensure DOM is updated
            setTimeout(() => {
                handleAutoGeneration('ai'); // Explicitly specify this is for AI messages
            }, 1000);
        }
    });
    
    eventSource.on(event_types.MESSAGE_SENT, () => {
        if (extension_settings[extensionName] && extension_settings[extensionName].enabled) {
            console.log("MESSAGE_SENT event - adding buttons and checking auto-generation for user message");
            addGenerateButtons();
            // Check if user message narration is enabled before proceeding
            if (extension_settings[extensionName].narrate_user) {
                console.log("User message narration is enabled - proceeding with auto-generation");
                setTimeout(() => {
                    handleAutoGeneration('user'); // Explicitly specify this is for user messages
                }, 1000);
            } else {
                console.log("User message narration is disabled - skipping auto-generation");
            }
        }
    });
    
    eventSource.on(event_types.CHAT_CHANGED, () => {
        if (extension_settings[extensionName] && extension_settings[extensionName].enabled) {
            addGenerateButtons();
            // Clear audio queue when chat changes
            globalAudioQueue = [];
            isPlayingQueue = false;
            currentlyPlayingMessage = null;
            isPaused = false;
            pausedAudioElement = null;
            pausedPosition = 0;
            updateQueueControlButton();
            console.log("Chat changed - cleared audio queue");
        }
    });
});
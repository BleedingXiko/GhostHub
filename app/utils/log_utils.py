import logging
import re
import os # Moved import os to the top

class LogObfuscationFilter(logging.Filter):
    """
    A custom logging filter to obfuscate sensitive information such as
    file paths, filenames, and chat messages from log records.
    """
    # Simplified and broadened path regex
    PATH_REGEX = re.compile(
        r"([a-zA-Z]:\\(?:[^\\<>:\"/|?*\r\n]+\\)*[^\\<>:\"/|?*\r\n]*)|"  # Windows (simplified char class)
        r"(/(?:[^/<>:\"|?*\r\n]+/)*[^/<>:\"|?*\r\n]*)"    # Unix (simplified char class)
    )
    # Simplified filename regex
    FILENAME_REGEX = re.compile(r"\b([\w.-]+\.[a-zA-Z0-9]{2,5})\b")
    # Regex for URL paths, including query strings
    URL_PATH_REGEX = re.compile(r"(/[^?\s<>\"|*\r\n]+(\?[^?\s<>\"|*\r\n]*)?)")

    def __init__(self, name=''):
        super().__init__(name)
        self.path_replacement = "[PATH_REDACTED]"
        self.filename_replacement = "[FILENAME_REDACTED]"
        self.url_path_replacement = "[URL_REDACTED]"
        self.chat_replacement = "[CHAT_MESSAGE_REDACTED]"

    def _obfuscate_paths_and_filenames(self, text_element):
        if not isinstance(text_element, str):
            return text_element

        # Step 1: Obfuscate URL paths first, as they are more specific for access logs.
        obfuscated_text = self.URL_PATH_REGEX.sub(self.url_path_replacement, text_element)
        
        # Step 2: Obfuscate entire file system paths.
        # This will turn "C:/path/to/file.txt" into "[PATH_REDACTED]".
        # This might catch parts of URLs if URL_PATH_REGEX didn't match fully, or other path-like strings.
        obfuscated_text = self.PATH_REGEX.sub(self.path_replacement, obfuscated_text)

        # Step 3: Obfuscate any remaining standalone filenames.
        obfuscated_text = self.FILENAME_REGEX.sub(self.filename_replacement, obfuscated_text)
        
        return obfuscated_text

    def filter(self, record):
        # Handle chat message redaction first
        is_chat_message = False
        if record.name and record.name.startswith('app.socket_events'):
            if isinstance(record.msg, str) and not self.PATH_REGEX.search(record.msg) and not self.FILENAME_REGEX.search(record.msg) :
                # If it's from socket_events and doesn't look like a path or filename, assume it's a chat message.
                record.msg = self.chat_replacement
                record.args = () # Clear args for chat messages to prevent further processing
                is_chat_message = True

        # Obfuscate paths and filenames if not already processed as a chat message
        if not is_chat_message:
            if record.msg and isinstance(record.msg, str):
                record.msg = self._obfuscate_paths_and_filenames(record.msg)

            if record.args:
                new_args = []
                for arg in record.args:
                    new_args.append(self._obfuscate_paths_and_filenames(arg))
                record.args = tuple(new_args)

        return True

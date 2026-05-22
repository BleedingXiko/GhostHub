"""Specter-owned access to runtime app config and Flask path metadata."""

import os

from flask import current_app, has_app_context

from app.config import Config
from specter import Service, registry


class RuntimeConfigService(Service):
    """Provide app config/path access without service modules reaching into current_app."""

    def __init__(self):
        super().__init__('runtime_config', {
            'app_bound': False,
        })

    def on_start(self):
        self.set_state({
            'app_bound': True,
        })

    @staticmethod
    def _app():
        manager = registry.resolve('service_manager')
        return manager.app if manager else None

    def get(self, key, default=None):
        """Return a Flask config value with Config fallback when app is unavailable."""
        app = self._app()
        if app is not None:
            return app.config.get(key, default)
        return getattr(Config, key, default)

    def set(self, key, value):
        """Update a runtime config value and mirror it to ``Config`` when present."""
        app = self._app()
        if app is not None:
            app.config[key] = value
        setattr(Config, key, value)
        return value

    def instance_path(self):
        """Return the active Flask instance path."""
        app = self._app()
        if app is not None:
            return app.instance_path
        return os.path.abspath(Config.INSTANCE_FOLDER_PATH)

    def root_path(self):
        """Return the active Flask root path."""
        app = self._app()
        if app is not None:
            return app.root_path
        return os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))

    def static_folder(self):
        """Return the active Flask static folder path."""
        app = self._app()
        if app is not None:
            return app.static_folder
        return os.path.abspath(Config.STATIC_FOLDER)


def get_runtime_config_value(key, default=None):
    """Read runtime config through Specter when available, else fall back to Config."""
    if has_app_context():
        return current_app.config.get(key, default)
    service = registry.resolve('runtime_config')
    if service:
        return service.get(key, default)
    return getattr(Config, key, default)


def get_runtime_instance_path():
    """Return the current Flask instance path with Config fallback."""
    if has_app_context():
        return current_app.instance_path
    service = registry.resolve('runtime_config')
    if service:
        return service.instance_path()
    return os.path.abspath(Config.INSTANCE_FOLDER_PATH)


def get_runtime_root_path():
    """Return the current Flask root path with filesystem fallback."""
    if has_app_context():
        return current_app.root_path
    service = registry.resolve('runtime_config')
    if service:
        return service.root_path()
    return os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))


def get_runtime_static_folder():
    """Return the current Flask static folder with Config fallback."""
    if has_app_context():
        return current_app.static_folder
    service = registry.resolve('runtime_config')
    if service:
        return service.static_folder()
    return os.path.abspath(Config.STATIC_FOLDER)


def get_runtime_flask_app():
    """Return the active Flask app object when Specter has already booted."""
    if has_app_context():
        return current_app._get_current_object()
    service = registry.resolve('runtime_config')
    if service:
        return service._app()
    return None


def set_runtime_config_value(key, value):
    """Write a runtime config value through Specter when available."""
    service = registry.resolve('runtime_config')
    if service:
        return service.set(key, value)
    setattr(Config, key, value)
    return value

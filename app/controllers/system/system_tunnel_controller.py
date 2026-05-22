"""System tunnel/network controller built on Specter."""

import logging
import traceback

from flask import request

from app.services.core.runtime_config_service import get_runtime_config_value
import app.services.system.network_detection_service as network_detection_service
import app.services.system.rate_limit_service as rate_limit_service
from app.services.system.headscale.access_service import (
    generate_client_preauth_key,
    register_node_from_url,
)
import app.services.system.tunnel.service as system_tunnel_service
from specter import Controller
from app.utils.auth import admin_required

logger = logging.getLogger(__name__)


class SystemTunnelController(Controller):
    """Own tunnel-management and network-health endpoints."""

    name = 'system_tunnel'
    url_prefix = '/api'

    def build_routes(self, router):
        @router.route('/tunnel/remove-node', methods=['POST'])
        @admin_required
        def remove_tunnel_node_route():
            """Remove a node from the mesh network."""
            return self.remove_tunnel_node()

        @router.route('/tunnel/update-dns', methods=['POST'])
        @admin_required
        def update_tunnel_dns():
            """Manually trigger mesh DNS update."""
            return self.update_tunnel_dns()

        @router.route('/tunnel/generate-key', methods=['POST'])
        @admin_required
        def generate_tunnel_key():
            """Generate a client-specific preauth key."""
            return self.generate_tunnel_key()

        @router.route('/tunnel/register-device', methods=['POST'])
        @admin_required
        def register_device_route():
            """Register a pending mesh device."""
            return self.register_device()

        @router.route('/tunnel/start', methods=['POST'])
        @admin_required
        def start_tunnel_route():
            """Start the requested tunnel provider."""
            return self.start_tunnel()

        @router.route('/tunnel/stop', methods=['POST'])
        @admin_required
        def stop_tunnel_route():
            """Stop the active tunnel."""
            return self.stop_tunnel()

        @router.route('/tunnel/status', methods=['GET'])
        def tunnel_status_route():
            """Get the current active tunnel status."""
            return self.get_tunnel_status()

        @router.route('/network-health', methods=['GET'])
        def network_health():
            """Get network health and rate-limiter state."""
            return self.get_network_health()

    def remove_tunnel_node(self):
        """Remove a node from the mesh network."""
        data = request.get_json(silent=True) or {}
        node_id = data.get('node_id')
        if not node_id:
            return {'status': 'error', 'message': 'Node ID is required.'}, 400

        return system_tunnel_service.remove_tunnel_node(node_id)

    def update_tunnel_dns(self):
        """Manually trigger DNS update for ghosthub.mesh.local."""
        try:
            success = system_tunnel_service.update_tunnel_dns()
            if success:
                return {'status': 'success', 'message': 'DNS updated successfully'}
            return {'status': 'error', 'message': 'Failed to update DNS'}, 500
        except Exception as exc:
            logger.error("Error updating DNS: %s", exc)
            return {'status': 'error', 'message': str(exc)}, 500

    def generate_tunnel_key(self):
        """Generate a client-specific preauth key with dynamic username."""
        try:
            data = request.get_json(silent=True) or {}
            client_info = data.get('client_info', {})
            username, preauth_key = generate_client_preauth_key(client_info)

            if not preauth_key:
                return {
                    'status': 'error',
                    'message': 'Failed to generate preauth key',
                }, 500

            return {
                'status': 'success',
                'message': 'Client preauth key generated',
                'username': username,
                'preauth_key': preauth_key,
            }
        except Exception as exc:
            logger.error("Error generating preauth key: %s", exc)
            return {'status': 'error', 'message': str(exc)}, 500

    def register_device(self):
        """Register a pending device using its node key."""
        data = request.get_json(silent=True) or {}
        node_key = data.get('node_key', '').strip()
        if not node_key:
            return {
                'status': 'error',
                'message': 'Node key is required. Copy it from the registration page.',
            }, 400

        success, message = register_node_from_url(node_key)
        if success:
            return {
                'status': 'success',
                'message': 'Device registered successfully! It should connect within a few seconds.',
            }
        return {'status': 'error', 'message': message}, 400

    def start_tunnel(self):
        """Start a tunnel based on request parameters."""
        try:
            data = request.get_json(silent=True)
            if not data:
                return {'status': 'error', 'message': 'Request body is missing.'}, 400

            provider = data.get('provider')
            local_port = data.get(
                'local_port',
                get_runtime_config_value('TUNNEL_LOCAL_PORT', 5000),
            )
            token = data.get('pinggy_token')
            return system_tunnel_service.start_tunnel(
                provider,
                local_port=int(local_port),
                pinggy_token=token,
                wait_for_network=True,
            )
        except ValueError:
            logger.error("Error in start_tunnel: Invalid port number provided.")
            return {'status': 'error', 'message': 'Invalid port number provided.'}, 400
        except Exception as exc:
            logger.error("Error in start_tunnel: %s", exc)
            logger.debug(traceback.format_exc())
            return {
                'status': 'error',
                'message': f'An unexpected error occurred: {str(exc)}',
            }, 500

    def stop_tunnel(self):
        """Stop the currently active tunnel."""
        try:
            return system_tunnel_service.stop_tunnel()
        except Exception as exc:
            logger.error("Error in stop_tunnel: %s", exc)
            logger.debug(traceback.format_exc())
            return {
                'status': 'error',
                'message': f'An unexpected error occurred: {str(exc)}',
            }, 500

    def get_tunnel_status(self):
        """Get the current status of the active tunnel."""
        try:
            return system_tunnel_service.get_tunnel_status()
        except Exception as exc:
            logger.error("Error in tunnel_status: %s", exc)
            logger.debug(traceback.format_exc())
            return {
                'status': 'error',
                'message': f'An unexpected error occurred: {str(exc)}',
            }, 500

    def get_network_health(self):
        """Get network health and performance metrics."""
        try:
            client_ip = request.remote_addr
            user_agent = request.headers.get('User-Agent', '')

            connection_info = network_detection_service.get_client_connection_type(
                client_ip,
                user_agent,
            )
            rate_stats = rate_limit_service.get_rate_limiter_stats()
            interfaces = network_detection_service.get_interface_ips()
            ap_active = network_detection_service.is_ap_mode_active()
            eth0_internet = network_detection_service.has_eth0_internet()

            return {
                'client': {
                    'ip': client_ip,
                    'interface': connection_info.get('interface'),
                    'connection_type': connection_info.get('connection_type'),
                    'tier': connection_info.get('tier'),
                    'is_mobile': connection_info.get('is_mobile'),
                },
                'interfaces': interfaces,
                'ap_mode_active': ap_active,
                'has_eth0_internet': eth0_internet,
                'rate_limiting': {
                    'active_clients': rate_stats.get('active_clients'),
                    'global_upload_tokens_available': rate_stats.get('global_upload_available'),
                    'global_download_tokens_available': rate_stats.get('global_download_available'),
                    'effective_upload_limit_mbps': rate_limit_service.get_effective_upload_limit_mbps(client_ip),
                },
                'health': 'healthy',
            }
        except Exception as exc:
            logger.error("Error getting network health: %s", exc)
            return {'error': 'Failed to get network health'}, 500

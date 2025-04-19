# app/socket_events.py
import logging
import time # Import the standard time module
import gevent # Import gevent for sleep
from flask import request, current_app
from flask_socketio import emit, join_room, leave_room, disconnect
from .services.sync_service import SyncService
from .constants import SYNC_ROOM, CHAT_ROOM # Import from constants

logger = logging.getLogger(__name__)

# SYNC_ROOM and CHAT_ROOM are now imported from constants

# Dictionary to track client connection attempts and errors
client_connection_stats = {}

def register_socket_events(socketio):
    """Registers SocketIO event handlers with improved error handling."""

    @socketio.on('connect')
    def handle_connect():
        """Handles new client connections with improved error tracking."""
        try:
            client_id = request.sid
            logger.info(f"Client connected: {client_id}")
            
            # Initialize connection stats for this client
            client_connection_stats[client_id] = {
                'connect_count': 1,
                'error_count': 0,
                'last_error': None
            }
            
            # Optionally, immediately add clients to the sync room if sync is active
            # if SyncService.is_sync_enabled():
            #     join_room(SYNC_ROOM)
            #     logger.info(f"Client {client_id} automatically joined {SYNC_ROOM}")
            #     # Send initial state to the newly connected client
            #     emit('sync_state', SyncService.get_current_media(), room=client_id)
            
            # Send connection acknowledgment to client
            emit('connection_status', {'status': 'connected', 'id': client_id}, room=client_id)
            
        except Exception as e:
            logger.error(f"Error during client connection: {str(e)}")
            # Don't raise the exception - this would prevent the connection

    @socketio.on('disconnect')
    def handle_disconnect(reason=None): # Accept an optional reason argument
        """Handles client disconnections with cleanup."""
        try:
            client_id = request.sid
            log_message = f"Client disconnected: {client_id}"
            if reason:
                log_message += f" (Reason: {reason})"
            logger.info(log_message)
            logger.info(f"Client disconnected: {client_id}")
            
            # Clean up connection stats for this client
            if client_id in client_connection_stats:
                del client_connection_stats[client_id]
                
        except Exception as e:
            logger.error(f"Error during client disconnection: {str(e)}")
    
    @socketio.on_error_default
    def default_error_handler(e):
        """Handles all SocketIO errors."""
        try:
            client_id = request.sid
            logger.error(f"SocketIO error for client {client_id}: {str(e)}")
            
            # Update error stats
            if client_id in client_connection_stats:
                client_connection_stats[client_id]['error_count'] += 1
                client_connection_stats[client_id]['last_error'] = str(e)
                
                # If too many errors, disconnect the client gracefully
                if client_connection_stats[client_id]['error_count'] > 5:
                    logger.warning(f"Too many errors for client {client_id}, disconnecting")
                    emit('connection_error', {'message': 'Too many errors, disconnecting'}, room=client_id)
                    # Use gevent sleep to allow the message to be sent before disconnecting
                    gevent.sleep(0.1)
                    disconnect(client_id)

        except Exception as nested_e:
            logger.error(f"Error in error handler: {str(nested_e)}")

    @socketio.on('join_sync')
    def handle_join_sync():
        """Handles a client explicitly joining the sync session with error handling."""
        try:
            client_id = request.sid
            session_id = request.cookies.get('session_id')
            logger.info(f"Client {client_id} (Session: {session_id}) requested to join sync.")

            if not SyncService.is_sync_enabled():
                logger.warning(f"Client {client_id} tried to join sync, but it's not enabled.")
                emit('sync_error', {'message': 'Sync mode is not currently active.'}, room=client_id)
                return

            join_room(SYNC_ROOM)
            logger.info(f"Client {client_id} joined room '{SYNC_ROOM}'")

            # Send the current media state only to the client that just joined
            current_state = SyncService.get_current_media()
            emit('sync_state', current_state, room=client_id)
            logger.info(f"Sent current sync state to {client_id}: {current_state}")

            # Notify others (e.g., host) that someone joined
            emit('user_joined', {'sid': client_id}, room=SYNC_ROOM, include_self=False)
            
        except Exception as e:
            logger.error(f"Error during join_sync: {str(e)}")
            emit('sync_error', {'message': f'Error joining sync: {str(e)}'}, room=client_id)

    @socketio.on('leave_sync')
    def handle_leave_sync():
        """Handles a client explicitly leaving the sync session with error handling."""
        try:
            client_id = request.sid
            logger.info(f"Client {client_id} requested to leave sync.")
            leave_room(SYNC_ROOM)
            logger.info(f"Client {client_id} left room '{SYNC_ROOM}'")
            # Notify others
            emit('user_left', {'sid': client_id}, room=SYNC_ROOM, include_self=False)
        except Exception as e:
            logger.error(f"Error during leave_sync: {str(e)}")

    # Note: The 'sync_update' event is triggered internally by the SyncService
    # when the host updates the media state via the HTTP endpoint.
    # We don't need a direct client-triggered 'sync_update' socket event
    # unless we want hosts to update via WebSocket too (which adds complexity).

    # Chat room event handlers
    @socketio.on('join_chat')
    def handle_join_chat():
        """Handles a client joining the chat room with error handling."""
        try:
            client_id = request.sid
            session_id = request.cookies.get('session_id')
            logger.info(f"Client {client_id} (Session: {session_id}) joined chat room.")
            join_room(CHAT_ROOM)
            
            # Notify others that someone joined
            emit('chat_notification', {
                'type': 'join',
                'message': 'A new user joined the chat'
            }, room=CHAT_ROOM, include_self=False)
        except Exception as e:
            logger.error(f"Error during join_chat: {str(e)}")

    @socketio.on('leave_chat')
    def handle_leave_chat():
        """Handles a client leaving the chat room with error handling."""
        try:
            client_id = request.sid
            logger.info(f"Client {client_id} left chat room.")
            leave_room(CHAT_ROOM)
            
            # Notify others that someone left
            emit('chat_notification', {
                'type': 'leave',
                'message': 'A user left the chat'
            }, room=CHAT_ROOM, include_self=False)
        except Exception as e:
            logger.error(f"Error during leave_chat: {str(e)}")

    @socketio.on('chat_message')
    def handle_chat_message(data):
        """Handles chat messages and broadcasts them to all users in the chat room with error handling."""
        try:
            if not data or 'message' not in data or not data['message'].strip():
                return
            
            client_id = request.sid
            session_id = request.cookies.get('session_id', 'unknown')
            user_id = session_id[:8]  # Use first 8 chars of session ID as user identifier
            
            message_data = {
                'user_id': user_id,
                'message': data['message'].strip(),
                'timestamp': data.get('timestamp', None)
            }
            
            logger.info(f"Chat message from {user_id} (client {client_id}): {message_data['message']}")
            
            # Broadcast the message to everyone in the chat room
            emit('chat_message', message_data, room=CHAT_ROOM)
        except Exception as e:
            logger.error(f"Error handling chat message: {str(e)}")
            # Try to notify the sender about the error
            try:
                emit('chat_error', {'message': 'Failed to send message'}, room=client_id)
            except:
                pass  # Ignore errors in the error handler

    # Add a heartbeat mechanism to keep connections alive
    @socketio.on('heartbeat')
    def handle_heartbeat():
        """Responds to client heartbeats to keep the connection alive."""
        try:
            client_id = request.sid
            # Simply respond with a pong to confirm the connection is still active
            emit('heartbeat_response', {'status': 'ok', 'timestamp': time.time()}, room=client_id) # Use time.time()
        except Exception as e:
            logger.error(f"Error during heartbeat: {str(e)}")

    logger.info("SocketIO event handlers registered with improved error handling.")

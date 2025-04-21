"""
GhostHub Socket Event Handlers
-----------------------------
Handles WebSocket events for real-time features including sync viewing and chat.
Uses Flask-SocketIO with room-based broadcasting for targeted communication.
"""
# app/socket_events.py

import logging
import time
import gevent
from flask import request, current_app
from flask_socketio import emit, join_room, leave_room, disconnect
from .services.sync_service import SyncService
from .constants import (
    SYNC_ROOM, 
    CHAT_ROOM,
    SOCKET_EVENTS as SE,
    ERROR_MESSAGES
)

logger = logging.getLogger(__name__)

# Track client connection stats for reliability monitoring
client_connection_stats = {}

def register_socket_events(socketio):
    """
    Registers SocketIO event handlers with improved error handling.
    
    Args:
        socketio: The SocketIO instance to register events with
    """

    @socketio.on(SE['CONNECT'])
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
            
            # Send connection acknowledgment to client
            emit(SE['CONNECTION_STATUS'], {'status': 'connected', 'id': client_id}, room=client_id)
            
        except Exception as e:
            logger.error(f"Error during client connection: {str(e)}")
            # Don't raise the exception - this would prevent the connection

    @socketio.on(SE['DISCONNECT'])
    def handle_disconnect(reason=None):
        """Handles client disconnections with cleanup."""
        try:
            client_id = request.sid
            log_message = f"Client disconnected: {client_id}"
            if reason:
                log_message += f" (Reason: {reason})"
            logger.info(log_message)
            
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
                    emit(SE['CONNECTION_ERROR'], {'message': 'Too many errors, disconnecting'}, room=client_id)
                    # Use gevent sleep to allow the message to be sent before disconnecting
                    gevent.sleep(0.1)
                    disconnect(client_id)

        except Exception as nested_e:
            logger.error(f"Error in error handler: {str(nested_e)}")

    @socketio.on(SE['JOIN_SYNC'])
    def handle_join_sync():
        """Handles a client explicitly joining the sync session with error handling."""
        try:
            client_id = request.sid
            session_id = request.cookies.get('session_id')
            logger.info(f"Client {client_id} (Session: {session_id}) requested to join sync.")

            if not SyncService.is_sync_enabled():
                logger.warning(f"Client {client_id} tried to join sync, but it's not enabled.")
                emit(SE['SYNC_ERROR'], {'message': ERROR_MESSAGES['SYNC_NOT_ENABLED']}, room=client_id)
                return

            join_room(SYNC_ROOM)
            logger.info(f"Client {client_id} joined room '{SYNC_ROOM}'")

            # Send the current media state only to the client that just joined
            current_state = SyncService.get_current_media()
            emit(SE['SYNC_STATE'], current_state, room=client_id)
            logger.info(f"Sent current sync state to {client_id}: {current_state}")

            # Notify others (e.g., host) that someone joined
            emit(SE['USER_JOINED'], {'sid': client_id}, room=SYNC_ROOM, include_self=False)
            
        except Exception as e:
            logger.error(f"Error during join_sync: {str(e)}")
            emit(SE['SYNC_ERROR'], {'message': f'Error joining sync: {str(e)}'}, room=client_id)

    @socketio.on(SE['LEAVE_SYNC'])
    def handle_leave_sync():
        """Handles a client explicitly leaving the sync session with error handling."""
        try:
            client_id = request.sid
            logger.info(f"Client {client_id} requested to leave sync.")
            leave_room(SYNC_ROOM)
            logger.info(f"Client {client_id} left room '{SYNC_ROOM}'")
            # Notify others
            emit(SE['USER_LEFT'], {'sid': client_id}, room=SYNC_ROOM, include_self=False)
        except Exception as e:
            logger.error(f"Error during leave_sync: {str(e)}")

    # Chat room event handlers
    @socketio.on(SE['JOIN_CHAT'])
    def handle_join_chat():
        """Handles a client joining the chat room with error handling."""
        try:
            client_id = request.sid
            session_id = request.cookies.get('session_id')
            logger.info(f"Client {client_id} (Session: {session_id}) joined chat room.")
            join_room(CHAT_ROOM)
            
            # Notify others that someone joined
            emit(SE['CHAT_NOTIFICATION'], {
                'type': 'join',
                'message': 'A new user joined the chat'
            }, room=CHAT_ROOM, include_self=False)
        except Exception as e:
            logger.error(f"Error during join_chat: {str(e)}")
            
    @socketio.on(SE['REJOIN_CHAT'])
    def handle_rejoin_chat():
        """Handles a client rejoining the chat room after a page refresh without sending a notification."""
        try:
            client_id = request.sid
            session_id = request.cookies.get('session_id')
            logger.info(f"Client {client_id} (Session: {session_id}) rejoined chat room after refresh.")
            join_room(CHAT_ROOM)
            # No notification is sent to other users
        except Exception as e:
            logger.error(f"Error during rejoin_chat: {str(e)}")

    @socketio.on(SE['LEAVE_CHAT'])
    def handle_leave_chat():
        """Handles a client leaving the chat room with error handling."""
        try:
            client_id = request.sid
            logger.info(f"Client {client_id} left chat room.")
            leave_room(CHAT_ROOM)
            
            # Notify others that someone left
            emit(SE['CHAT_NOTIFICATION'], {
                'type': 'leave',
                'message': 'A user left the chat'
            }, room=CHAT_ROOM, include_self=False)
        except Exception as e:
            logger.error(f"Error during leave_chat: {str(e)}")

    @socketio.on(SE['CHAT_MESSAGE'])
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
            emit(SE['CHAT_MESSAGE'], message_data, room=CHAT_ROOM)
        except Exception as e:
            logger.error(f"Error handling chat message: {str(e)}")
            # Try to notify the sender about the error
            try:
                emit(SE['CHAT_ERROR'], {'message': 'Failed to send message'}, room=client_id)
            except:
                pass  # Ignore errors in the error handler

    # Add a heartbeat mechanism to keep connections alive
    @socketio.on(SE['HEARTBEAT'])
    def handle_heartbeat():
        """Responds to client heartbeats to keep the connection alive."""
        try:
            client_id = request.sid
            # Simply respond with a pong to confirm the connection is still active
            emit(SE['HEARTBEAT_RESPONSE'], {'status': 'ok', 'timestamp': time.time()}, room=client_id)
        except Exception as e:
            logger.error(f"Error during heartbeat: {str(e)}")

    logger.info("SocketIO event handlers registered with improved error handling.")

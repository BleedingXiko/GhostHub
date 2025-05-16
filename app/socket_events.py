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
from .services import progress_service # Added for saving current index
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
            session_id = request.cookies.get('session_id') # Get session ID before disconnect
            log_message = f"Client disconnected: {client_id} (Session: {session_id})"
            if reason:
                log_message += f" (Reason: {reason})"
            logger.info(log_message)
            
            # Clean up connection stats for this client
            if client_id in client_connection_stats:
                del client_connection_stats[client_id]
                
            # Remove session state if it exists
            if session_id:
                SyncService.remove_session_state(session_id)
                
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

            # Send current category activity to the newly joined client
            try:
                counts = SyncService.get_category_session_counts()
                emit(SE['CATEGORY_ACTIVITY_UPDATE'], counts, room=client_id)
                logger.info(f"Sent category activity to new client {client_id}: {counts}")
            except Exception as ex_activity:
                logger.error(f"Error sending category activity to {client_id}: {ex_activity}")

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

            # Send current category activity to the rejoined client
            try:
                counts = SyncService.get_category_session_counts()
                emit(SE['CATEGORY_ACTIVITY_UPDATE'], counts, room=client_id)
                logger.info(f"Sent category activity to rejoined client {client_id}: {counts}")
            except Exception as ex_activity:
                logger.error(f"Error sending category activity to rejoined {client_id}: {ex_activity}")
                
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
            
    # Command handlers for slash commands
    @socketio.on(SE['COMMAND'])
    def handle_command(data):
        """Handles command events (e.g., /myview) and broadcasts them to other users."""
        try:
            if not data or 'cmd' not in data:
                return
                
            client_id = request.sid
            session_id = request.cookies.get('session_id', 'unknown')
            
            # Currently only /myview command is supported for broadcasting
            if data['cmd'] == 'myview':
                # Validate required fields
                if 'arg' not in data or 'from' not in data:
                    logger.warning(f"Invalid command data from {client_id}: missing required fields")
                    return
                    
                # Validate arg contains required fields for myview
                if not isinstance(data['arg'], dict) or 'category_id' not in data['arg'] or 'index' not in data['arg']:
                    logger.warning(f"Invalid myview command data from {client_id}: missing category_id or index")
                    return
                
                # Retrieve the sender's current state, including media order
                sender_state = SyncService.get_session_state(session_id)
                media_order = sender_state.get('media_order') if sender_state else None
                
                # Log the command and order info
                logger.info(f"Command from {session_id} (client {client_id}): {data['cmd']} with args: {data['arg']}, Order URLs: {len(media_order) if media_order else 'N/A'}")
                
                # Add media_order to the payload if available
                if media_order:
                    data['arg']['media_order'] = media_order
                else:
                    logger.warning(f"Could not retrieve media order for session {session_id} when handling /myview")
                    # Optionally, send an error back or just omit the order
                
                # Broadcast the command (including media_order if found)
                emit(SE['COMMAND'], data, room=CHAT_ROOM, include_self=True) # Send to sender too
            else:
                logger.warning(f"Unsupported command type: {data['cmd']}")
                
        except Exception as e:
            logger.error(f"Error handling command: {str(e)}")
            # Try to notify the sender about the error
            try:
                emit(SE['CHAT_ERROR'], {'message': 'Failed to process command'}, room=client_id)
            except:
                pass  # Ignore errors in the error handler


    @socketio.on(SE['UPDATE_MY_STATE'])
    def handle_update_my_state(data):
        """Handles clients reporting their current view state with enhanced validation."""
        try:
            client_id = request.sid
            session_id = request.cookies.get('session_id')
            
            if not session_id:
                logger.warning(f"Client {client_id} tried to update state without session ID.")
                return
                
            # Validate data structure
            if not data or 'category_id' not in data or 'index' not in data or 'media_order' not in data:
                logger.warning(f"Invalid state update data from {session_id} (client {client_id}): Missing fields - {data}")
                return
                
            category_id = data['category_id']
            index = data['index']
            media_order = data['media_order'] # Get the media order
            
            # Validate category_id format
            if not isinstance(category_id, str) or not category_id.strip():
                logger.warning(f"Invalid category_id in state update from {session_id}: {category_id}")
                return
                
            # Ensure index is a valid integer
            try:
                index = int(index)
                if index < 0:
                    raise ValueError("Index cannot be negative")
            except (ValueError, TypeError) as e:
                logger.warning(f"Invalid index in state update from {session_id}: {index} - {str(e)}")
                return
                
            # Validate media_order format (should be a list of strings)
            if not isinstance(media_order, list) or not all(isinstance(url, str) for url in media_order):
                logger.warning(f"Invalid media_order format in state update from {session_id}: {media_order}")
                return

            logger.info(f"Updating view state for {session_id}: category={category_id}, index={index}, order_length={len(media_order)}")
            
            # Update the state in the service, now including media_order
            success = SyncService.update_session_state(session_id, category_id, index, media_order)

            if current_app.config.get('SAVE_CURRENT_INDEX', False):
                ps_success, ps_message = progress_service.save_progress(category_id, index)
                if not ps_success:
                    logger.warning(f"Failed to save current index for category {category_id}: {ps_message}")
            
            if not success:
                logger.error(f"Failed to update session state for session {session_id}")
                # Send error back to client if needed
                emit(SE['CHAT_ERROR'], {
                    'message': 'Failed to save your view state'
                }, room=client_id)
            else:
                logger.debug(f"Successfully updated state for {session_id}")
            
        except Exception as e:
            logger.error(f"Error handling state update: {str(e)}")
            # Try to notify the client about the error
            try:
                emit(SE['CHAT_ERROR'], {
                    'message': 'Failed to update your view state'
                }, room=client_id)
            except:
                pass  # Ignore errors in the error handler

    @socketio.on(SE['REQUEST_VIEW_INFO'])
    def handle_request_view_info(data):
        """Handles a client requesting view information for another session."""
        try:
            requesting_client_id = request.sid
            # Use the cookie-based session_id for the requesting user, for logging/context
            requesting_session_id = request.cookies.get('session_id', 'unknown_requestor') 
            
            if not data or 'target_session_id' not in data:
                logger.warning(f"Client {requesting_client_id} (Session: {requesting_session_id}) sent invalid request_view_info: {data}")
                emit(SE['VIEW_INFO_RESPONSE'], {'error': 'Invalid request. Missing target_session_id.'}, room=requesting_client_id)
                return

            target_session_id = data['target_session_id']
            logger.info(f"Client {requesting_client_id} (Session: {requesting_session_id}) requested view info for target session: {target_session_id}")

            target_state = SyncService.get_session_state(target_session_id)

            if target_state:
                logger.info(f"Found state for target session {target_session_id}: {target_state}")
                # Ensure all necessary components are present
                if 'category_id' in target_state and 'index' in target_state and 'media_order' in target_state:
                    emit(SE['VIEW_INFO_RESPONSE'], {
                        'category_id': target_state['category_id'],
                        'index': target_state['index'],
                        'media_order': target_state['media_order'],
                        'target_session_id': target_session_id # Echo back for confirmation
                    }, room=requesting_client_id)
                else:
                    logger.warning(f"Incomplete state for target session {target_session_id}: {target_state}")
                    emit(SE['VIEW_INFO_RESPONSE'], {'error': f'View information for session {target_session_id} is incomplete.'}, room=requesting_client_id)
            else:
                logger.info(f"No state found for target session {target_session_id}")
                emit(SE['VIEW_INFO_RESPONSE'], {'error': f'Could not find view information for session {target_session_id}. User might not be active or sharing.'}, room=requesting_client_id)
        
        except Exception as e:
            logger.error(f"Error handling request_view_info: {str(e)}")
            try:
                # Ensure the event name here matches what the client expects for an error
                emit(SE['VIEW_INFO_RESPONSE'], {'error': 'Server error processing your request.'}, room=requesting_client_id)
            except:
                pass # Ignore errors in the error handler

    logger.info("SocketIO event handlers registered with improved error handling.")

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
from flask import request, current_app, session # Added session
from flask_socketio import emit, join_room, leave_room, disconnect
from .services.sync_service import SyncService
from .services import progress_service
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
        """Handles new client connections with improved error tracking and active connection management."""
        client_id = request.sid
        client_ip = request.remote_addr
        flask_session_id = request.cookies.get('session_id')

        if client_ip in current_app.blocked_ips:
            logger.warning(f"Blocked IP {client_ip} (Client SID: {client_id}) attempted WebSocket connection. Disconnecting.")
            emit(SE['YOU_HAVE_BEEN_KICKED'], {'message': 'Your IP has been temporarily blocked from this session.'}, room=client_id)
            disconnect(sid=client_id)
            return

        try:
            logger.info(f"Client connected: {client_id} (IP: {client_ip}, Session: {flask_session_id})")
            
            if flask_session_id:
                current_app.active_connections[flask_session_id] = {
                    'sid': client_id,
                    'ip': client_ip,
                    'user_id': flask_session_id[:8] # Store short user_id for easier lookup
                }
                logger.info(f"Added to active_connections: {flask_session_id} -> {current_app.active_connections[flask_session_id]}")
            else:
                logger.warning(f"Client {client_id} connected without a flask_session_id cookie.")

            # Initialize connection stats for this client
            client_connection_stats[client_id] = {
                'connect_count': 1,
                'error_count': 0,
                'last_error': None
            }
            
            # Send connection acknowledgment to client
            emit(SE['CONNECTION_STATUS'], {'status': 'connected', 'id': client_id}, room=client_id)
            
        except Exception as e:
            logger.error(f"Error during client connection for {client_id} (IP: {client_ip}): {str(e)}")
            # Don't raise the exception - this would prevent the connection

    @socketio.on(SE['DISCONNECT'])
    def handle_disconnect(reason=None):
        """Handles client disconnections with cleanup, including active_connections."""
        client_id = request.sid
        flask_session_id = request.cookies.get('session_id') 
        
        log_message = f"Client disconnected: {client_id} (Session: {flask_session_id})"
        if reason:
            log_message += f" (Reason: {reason})"
        logger.info(log_message)

        try:
            # Clean up connection stats for this client
            if client_id in client_connection_stats:
                del client_connection_stats[client_id]
                
            # Remove from active_connections
            if flask_session_id and flask_session_id in current_app.active_connections:
                del current_app.active_connections[flask_session_id]
                logger.info(f"Removed from active_connections: {flask_session_id}")
            elif flask_session_id:
                logger.warning(f"Flask session ID {flask_session_id} not found in active_connections during disconnect for client {client_id}.")
            else:
                # If no flask_session_id, try to find by sid (less ideal)
                found_key = None
                for key, value in current_app.active_connections.items():
                    if value['sid'] == client_id:
                        found_key = key
                        break
                if found_key:
                    del current_app.active_connections[found_key]
                    logger.info(f"Removed from active_connections by SID lookup: {found_key} (Client SID: {client_id})")


            # Remove session state if it exists (original SyncService cleanup)
            if flask_session_id:
                SyncService.remove_session_state(flask_session_id)
                
        except Exception as e:
            logger.error(f"Error during client disconnection for {client_id} (Session: {flask_session_id}): {str(e)}")
    
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

    @socketio.on(SE['ADMIN_KICK_USER'])
    def handle_admin_kick_user(data):
        """Handles an admin's request to kick a user."""
        admin_client_sid = request.sid
        admin_flask_session_id = request.cookies.get('session_id')
        
        logger.info(f"Admin kick request received from admin {admin_flask_session_id} (SID: {admin_client_sid}) for target_user_id: {data.get('target_user_id')}")

        # 1. Verify admin privileges
        # Rely on the global ADMIN_SESSION_ID which is set via an HTTP route where session['is_admin'] is also set.
        # This avoids potential issues with Flask session availability in SocketIO context if not perfectly synced.
        is_true_admin = admin_flask_session_id is not None and \
                        admin_flask_session_id == current_app.ADMIN_SESSION_ID
        
        if not is_true_admin:
            logger.warning(f"Unauthorized kick attempt by non-admin or mismatched session: {admin_flask_session_id} (SID: {admin_client_sid}), global admin: {current_app.ADMIN_SESSION_ID}")
            emit(SE['ADMIN_KICK_CONFIRMATION'], {
                'success': False, 
                'message': 'Error: You do not have permission to perform this action.'
            }, room=admin_client_sid)
            return

        target_user_id = data.get('target_user_id')
        if not target_user_id or len(target_user_id) != 8: # Assuming user_id is first 8 chars of session_id
            logger.warning(f"Invalid target_user_id from admin {admin_flask_session_id}: {target_user_id}")
            emit(SE['ADMIN_KICK_CONFIRMATION'], {
                'success': False, 
                'message': 'Error: Invalid target user ID format.'
            }, room=admin_client_sid)
            return

        # 2. Find target user in active_connections
        target_flask_session_id = None
        target_connection_info = None
        
        # Iterate safely over a copy of items if modifications are possible, though here we just read
        for f_sid, conn_info in list(current_app.active_connections.items()): 
            if conn_info.get('user_id') == target_user_id:
                target_flask_session_id = f_sid
                target_connection_info = conn_info
                break
        
        if not target_connection_info:
            logger.info(f"Admin {admin_flask_session_id} tried to kick non-existent/inactive user: {target_user_id}")
            emit(SE['ADMIN_KICK_CONFIRMATION'], {
                'success': False, 
                'message': f"Error: User '{target_user_id}' not found or is not currently active."
            }, room=admin_client_sid)
            return

        # 3. Prevent self-kick
        if target_flask_session_id == admin_flask_session_id:
            logger.info(f"Admin {admin_flask_session_id} attempted self-kick.")
            emit(SE['ADMIN_KICK_CONFIRMATION'], {
                'success': False, 
                'message': 'Error: You cannot kick yourself.'
            }, room=admin_client_sid)
            return

        # 4. Perform Kick
        target_sid = target_connection_info['sid']
        target_ip = target_connection_info['ip']

        try:
            logger.info(f"Admin {admin_flask_session_id} is kicking user {target_user_id} (Session: {target_flask_session_id}, SID: {target_sid}, IP: {target_ip})")
            
            # Add IP to blocklist
            current_app.blocked_ips.add(target_ip)
            logger.info(f"IP {target_ip} added to blocklist. Current blocklist size: {len(current_app.blocked_ips)}")

            # Notify the kicked user
            emit(SE['YOU_HAVE_BEEN_KICKED'], {
                'message': 'You have been kicked from the session by an administrator. Your IP has been temporarily blocked.'
            }, room=target_sid)
            
            # Disconnect the user (allow a moment for the message to send)
            gevent.sleep(0.1) # Small delay to help ensure message delivery before disconnect
            disconnect(sid=target_sid)
            logger.info(f"Disconnected user {target_user_id} (SID: {target_sid})")

            # Confirm to admin
            emit(SE['ADMIN_KICK_CONFIRMATION'], {
                'success': True, 
                'message': f"User '{target_user_id}' (IP: {target_ip}) has been kicked and their IP blocked for this session."
            }, room=admin_client_sid)

        except Exception as e:
            logger.error(f"Error during kick process for target {target_user_id} by admin {admin_flask_session_id}: {str(e)}")
            emit(SE['ADMIN_KICK_CONFIRMATION'], {
                'success': False, 
                'message': f"Server error while trying to kick user: {str(e)}"
            }, room=admin_client_sid)

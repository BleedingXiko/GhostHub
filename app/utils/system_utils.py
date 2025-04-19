# app/utils/system_utils.py
import socket
import logging

logger = logging.getLogger(__name__)

def get_local_ip():
    """
    Get the local IP address of the machine.

    Returns:
        str: Local IP address or '127.0.0.1' if unable to determine.
    """
    try:
        # Create a socket that doesn't actually connect to anything
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        # Connect to an external IP (doesn't send packets)
        s.connect(("8.8.8.8", 80))
        local_ip = s.getsockname()[0]
        s.close()
        logger.info(f"Determined local IP using socket connect: {local_ip}")
        return local_ip
    except Exception as e:
        logger.warning(f"Error getting local IP via socket connect: {str(e)}")
        # Fallback method
        try:
            hostname = socket.gethostname()
            local_ip = socket.gethostbyname(hostname)
            logger.info(f"Determined local IP using hostname: {local_ip}")
            return local_ip
        except Exception as e_fallback:
            logger.error(f"Error getting local IP via fallback hostname method: {str(e_fallback)}")
            logger.warning("Falling back to 127.0.0.1 as local IP.")
            return "127.0.0.1"  # Last resort fallback

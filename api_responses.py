"""
Centralized API Response Management

This module standardizes API responses across the application.
"""

import json
from flask import jsonify


def success_response(data=None, message="Operation completed successfully"):
    """
    Create a standardized success response
    
    Args:
        data (dict): Data to return in response
        message (str): Success message
        
    Returns:
        Flask Response: JSON response with standard structure
    """
    response = {
        "success": True,
        "message": message,
        "data": data or {}
    }
    return jsonify(response)


def error_response(error_message, error_code=400, details=None):
    """
    Create a standardized error response
    
    Args:
        error_message (str): Human-readable error message
        error_code (int): HTTP status code
        details (dict): Additional error details
        
    Returns:
        Flask Response: JSON response with standard structure  
    """
    response = {
        "success": False,
        "error": error_message,
        "code": error_code,
        "details": details or {}
    }
    return jsonify(response), error_code


def validate_request_data(data, required_fields):
    """
    Validate that required fields are present in request data
    
    Args:
        data (dict): Request data to validate
        required_fields (list): List of required field names
        
    Returns:
        tuple: (is_valid, error_message)
    """
    if not isinstance(data, dict):
        return False, "Request data must be a JSON object"
        
    missing_fields = [field for field in required_fields if field not in data]
    
    if missing_fields:
        return False, f"Missing required fields: {', '.join(missing_fields)}"
        
    return True, None


# Response utility functions for common scenarios
def response_with_data(data):
    """Simple response with data payload"""
    return success_response(data=data)


def response_with_message(message):
    """Simple response with message only"""
    return success_response(message=message)


def response_empty():
    """Empty successful response""" 
    return success_response()
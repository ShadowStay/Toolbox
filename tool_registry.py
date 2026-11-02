"""
Central Tool Registry for Iprix's Spells

This module provides a unified system for managing tools across the application.
Tools are registered once and can be accessed from anywhere in the application.
"""

# Central registry for all tools
_TOOL_REGISTRY = {}

def register_tool(name, category=None, icon=None, description=None, route=None, 
                  favorite_supported=False, metadata=None):
    """
    Register a new tool in the central registry.
    
    Args:
        name (str): Unique identifier for the tool
        category (str): Category of the tool (e.g., 'Productivity', 'Storage')  
        icon (str): Unicode character or icon identifier
        description (str): Brief description of tool functionality
        route (str): Route path to the tool's main page
        favorite_supported (bool): Whether tool supports being favorited
        metadata (dict): Additional tool metadata
    """
    tool_data = {
        'name': name,
        'category': category,
        'icon': icon,
        'description': description,
        'route': route,
        'favorite_supported': favorite_supported,
        'metadata': metadata or {}
    }
    
    _TOOL_REGISTRY[name] = tool_data

def get_tool(name):
    """
    Retrieve a tool from the registry.
    
    Args:
        name (str): Tool identifier
        
    Returns:
        dict: Tool information or None if not found
    """
    return _TOOL_REGISTRY.get(name)

def get_all_tools():
    """
    Get all registered tools.
    
    Returns:
        list: List of all tool dictionaries  
    """
    return list(_TOOL_REGISTRY.values())

def get_tools_by_category(category):
    """
    Get all tools in a specific category.
    
    Args:
        category (str): Category name
        
    Returns:
        list: Tools in that category
    """
    return [tool for tool in _TOOL_REGISTRY.values() if tool.get('category') == category]

def unregister_tool(name):
    """
    Remove a tool from the registry.
    
    Args:
        name (str): Tool identifier to remove
    """
    _TOOL_REGISTRY.pop(name, None)

def clear_registry():
    """
    Clear all registered tools (for testing or reset).
    """
    _TOOL_REGISTRY.clear()

# Register existing tools - we'll do this after the app is initialized 
def initialize_default_tools():
    """Initialize registry with default tools from current application."""
    # Tool registrations will be done in app.py or other initialization code
    pass

# Initialize by default  
initialize_default_tools()
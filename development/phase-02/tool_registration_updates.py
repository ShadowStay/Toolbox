"""
Update script that would register all currently defined tools in app.py TOOLS dictionary 
into our new central registry.
"""

# This simulates the updates we'd make to register existing tools

from shared.tool_registry import register_tool

# Register each tool from the current TOOLS dictionary
tools_to_register = {
    "text-tools": {"category": "Text", "icon": "✎", "description": "Regex find and replace, case conversion, line operations, extraction, encoding, text diff."},
    "image-tools": {"category": "Images", "icon": "❖", "description": "Layered image editor: transform, crop, filters, grid arrangement, tile split, format conversion."},  
    "omni-file-viewer": {"category": "Documents", "icon": "❂", "description": "Viewer, converter and merger for images, PDF, DOCX, spreadsheets, text, audio and video."},
    "calculator": {"category": "Calculators", "icon": "∑", "description": "Expressions, unit conversion, equations and linear systems."},
    "cloud-storage": {"category": "Storage", "icon": "☁", "description": "Shared file storage, 500 GB, resumable uploads."}, 
    "fortune-wheel": {"category": "Utilities", "icon": "✺", "description": "Random pick from a list of entries."},
    "live": {"category": "Communication", "icon": "☄", "description": "Chat room with voice, screen sharing and a drawing board."},
    "tabletop": {"category": "Tabletop RPG", "icon": "✠", "description": "Character sheets, dice log, battle map with fog of war, combat tracker."}
}

for tool_name, tool_info in tools_to_register.items():
    register_tool(
        name=tool_name,
        category=tool_info['category'],
        icon=tool_info['icon'], 
        description=tool_info['description'],
        route=f"/{tool_name}",  # Route would be based on tool name
        favorite_supported=True,  # Most tools support favorites
        metadata={"origin": "app.py"}
    )

print("Registered all existing tools in central registry")
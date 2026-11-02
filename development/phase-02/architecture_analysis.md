# Current Architecture Analysis

## Overview of Existing System

After analyzing the current application, I can see that Iprix's Spells has a Flask-based monolithic architecture with several key components and patterns:

## Core Components

1. **Authentication System** (`auth.py`)
   - Password authentication 
   - Session management with secure cookies
   - Route protection and public paths

2. **Blueprints** (registered in app.py)
   - `chat_bp` - Chat functionality 
   - `board_bp` - Drawing board (Live page)
   - `processing_bp` - Server-side processing tools
   - `storage_bp` - Cloud storage

3. **Tool Pages** (`pages/` directory)  
   - HTML templates for each tool
   - Automatic CSS/JS attachment based on filename

4. **Shared Resources** (`shared/` directory)
   - Shared CSS (`site.css`)
   - Shared JavaScript (`site.js`) 
   - Other common assets

5. **Tool List Registry** (defined in `app.py` line 33)
   - Centralized definition of available tools
   - Tool metadata: glyph, description
   - Used to generate the home page tool list

## Current Design Patterns

### Routing Pattern
- Routes automatically derived from file names
- `/api/` routes handled by blueprints (processing/, storage/)
- Page routes (`/<path:url>`) with automatic asset linking

### Tool Registration
- Tools defined in `app.py` via blueprints 
- Additional tools listed in TOOLS dictionary for display on home page
- All tools rendered dynamically from file structure

### Shared Components  
- CSS and JS shared across all pages through `shared/` directory
- Site-wide JavaScript functions (options, sidebar)
- Automatic HTML injection via `inject()` function

## Architecture Strengths

1. **Simple yet effective**: Monolithic approach works well for Raspberry Pi deployment
2. **Consistent structure**: Pages follow predictable naming conventions  
3. **Dynamic tool discovery**: Tool pages rendered directly from file system
4. **Good separation of concerns**:
   - Authentication handled separately
   - Storage in dedicated component
   - Processing in separate modules 
   - UI in pages directory

## Areas for Improvement

### 1. Tool Registration System
- Currently both blueprints and TOOLS dictionary manage tools 
- No centralized tool registry to manage tool lifecycle
- Tools are scattered across different components

### 2. Shared Components
- JavaScript code is mixed between `shared/site.js` and page-specific files
- Limited reusability of UI components
- No clear pattern for shared functionality

### 3. API Standardization  
- API responses vary in structure
- Error handling not consistent
- Data schema management needed

### 4. Navigation & Discovery
- Tool list is static dictionary
- User experience lacking organization features (favorites, recent usage)

### 5. Configuration Management
- Environment variables used but no structured config system
- Settings are applied in inconsistent locations

This analysis will guide the implementation of Phase 2 improvements to make the application more maintainable while preserving all existing functionality.
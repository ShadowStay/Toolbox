# Iprix's Spells Architecture

## Overview
This document describes the current architecture of Iprix's Spells and serves as a reference for ongoing development.

## High-Level Architecture

### Application Structure
Iprix's Spells is a Flask-based web application that follows a monolithic architecture approach. The application is designed to run on a Raspberry Pi 5, with performance considerations built in throughout the system design.

### Core Components

1. **Authentication System** (`auth.py`)
   - Password-based authentication using scrypt hashing
   - Session management via secure cookies  
   - Route protection with decorators
   - Login/logout handling with rate limiting

2. **File Storage System** (`storage.py`) 
   - Cloud storage with chunked uploads
   - SQLite database for metadata indexing
   - On-disk file storage with 500GB limit
   - Resumable uploads with recovery capability

3. **Frontend Components** (`shared/`, `pages/`)
   - Shared CSS and JavaScript in `shared/` directory  
   - Individual tool pages in `pages/` with automatic asset linking
   - HTML templates with embedded CSS/JS

4. **Processing Pipeline** (`processing/`)
   - Server-side operations for text, image and file processing 
   - Tool-specific processing modules (text.py, image.py, files.py)
   - Tabletop system components (roles.py, campaigns.py, characters.py)

5. **Communication System** (`chat.py`, `board.py`)
   - Real-time chat functionality
   - Drawing board for collaborative work  
   - Voice and screen sharing capabilities

## Data Flow

### Authentication Flow
1. User attempts to access protected resource
2. Authentication check via `is_authed()` function
3. If authenticated, allow access; otherwise redirect to login page
4. Login validation using password hash with rate limiting

### File Storage Flow
1. Upload begins with `/api/storage/upload` POST 
2. Temporary file created in `storage/tmp/`
3. Chunked data received via `PUT /api/storage/upload/<id>` requests
4. Finalization with `/api/storage/upload/<id>/finish` 
5. File moved to permanent location in `storage/blobs/`
6. Database entry created in SQLite index

### Page Serving Flow
1. Request for URL mapped to routing pattern
2. If tool page, check authentication and load HTML template  
3. Automatically inject linked CSS and JS files
4. Apply cookie settings to page HTML element
5. Return rendered page to client

## Design Patterns Used

### Routing Pattern
- Blueprint-based organization of routes
- Flexible URL pattern matching with `<path:url>` fallback
- Automatic CSS/JS linking based on HTML filename

### State Management
- Cookies for user preferences and session state  
- Server-side storage for persistent data
- Shared JS utilities for consistent behavior

## Implementation Constraints

### Hardware Limitations (Raspberry Pi 5)
- Resource constraints require efficient memory usage 
- Performance must remain responsive under load
- Browser-side processing preferred to reduce server load

### Security Requirements
- All protected resources validated by authentication system  
- Session management with proper cookie security
- Input validation on all API endpoints
- No trust in client-side permission checks

## Component Interactions

### Authentication and Storage
The storage system validates user authentication before allowing file operations.
All storage APIs require a valid session cookie.

### Frontend and Backend
Shared JavaScript utilities (`site.js`) manage frontend behavior including:
- Cookie handling for preferences
- Sidebar navigation 
- Options dialog management

### Processing and Tools
Processing module (processing/) handles server-side tools when "server" option is selected.
Tools can choose to process on browser or server via UI settings.

## Current State Summary 

The application maintains a cohesive architecture that balances functionality with resource constraints. The monolithic approach works well for the intended Raspberry Pi deployment, providing:
- Simple maintenance and development workflow
- Consistent data access patterns
- Clear separation of concerns between components 
- Efficient resource utilization appropriate for constrained hardware

This structure provides a solid foundation for implementing roadmap features while maintaining system stability and performance.
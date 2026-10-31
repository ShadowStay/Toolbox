# Architectural Decisions

## Overview
This document records significant architectural decisions made during the implementation of Iprix's Spells, based on the assessment and roadmap.

## Key Decisions

### 1. Maintenance of Flask Monolith Architecture
**Decision**: Continue with the existing Flask monolith architecture rather than introducing microservices.
**Rationale**: 
- The application is designed to run on a Raspberry Pi 5 which has limited resources
- Maintains simplicity for single developer maintenance
- Existing tooling and patterns work well with this approach
- No compelling technical reason to change at this stage

### 2. Browser-Centric Processing Approach
**Decision**: Prefer browser-side processing for most operations where practical.
**Rationale**:
- Reduces server load, especially important on Raspberry Pi
- Aligns with the existing architecture constraints
- Better user experience with responsive interfaces
- Follows the principle of keeping the Pi lightweight

### 3. Server-Side Processing for Complex Operations  
**Decision**: Use server-side processing for compute-intensive or operations requiring system resources.
**Rationale**:
- Operations like file conversion, complex text processing, and image manipulation may need server resources
- When "server" option is chosen in UI, operations run on server side
- Balances performance with resource usage

### 4. File Storage Strategy  
**Decision**: Keep files stored on disk under data/storage/blobs/ with SQLite metadata index.
**Rationale**:
- Existing implementation works well and has been tested
- Supports resumable uploads and recoverable operations
- Provides good balance between performance and complexity 
- Allows for future expansion without major restructuring

### 5. Authentication and Authorization
**Decision**: Maintain current password-based authentication with cookie sessions.
**Rationale**:
- Already implemented and secure
- Follows established patterns 
- No need to replace working system without clear benefit

## Implementation Approach

### Development Structure
- Use development/ phase directories for isolated work areas
- Maintain existing directory conventions inside phase folders
- Keep the application runnable throughout development with proper integration
- Avoid duplicating entire existing codebase

### Testing Strategy
- Establish lightweight testing framework appropriate for existing stack
- Run regression tests after each change
- Focus on critical behavior testing and edge cases  
- Verify performance against Raspberry Pi constraints

### Documentation Approach
- Maintain documentation consistency with actual implementation
- Update architecture and progress regularly 
- Keep API, data structure, and configuration documentation current
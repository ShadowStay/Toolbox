/**
 * Central Tool Registry for Iprix's Spells - Frontend Version
 *
 * This module provides a unified system for managing tools on the client-side.
 */

// Central registry for all tools
const toolRegistry = new Map();

/**
 * Register a new tool in the central registry
 * 
 * @param {Object} tool - Tool definition object
 * @param {string} tool.name - Unique identifier for the tool
 * @param {string} tool.category - Category of the tool (e.g., 'Productivity', 'Storage')  
 * @param {string} tool.icon - Unicode character or icon identifier
 * @param {string} tool.description - Brief description of tool functionality
 * @param {string} tool.route - Route path to the tool's main page
 * @param {boolean} tool.favoriteSupported - Whether tool supports being favorited
 * @param {Object} tool.metadata - Additional tool metadata
 */
export function registerTool(tool) {
    if (!tool.name) {
        throw new Error('Tool must have a name');
    }
    toolRegistry.set(tool.name, tool);
}

/**
 * Retrieve a tool from the registry
 * 
 * @param {string} name - Tool identifier
 * @returns {Object|null} Tool information or null if not found
 */
export function getTool(name) {
    return toolRegistry.get(name) || null;
}

/**
 * Get all registered tools
 * 
 * @returns {Array} List of all tool objects
 */
export function getAllTools() {
    return Array.from(toolRegistry.values());
}

/**
 * Get all tools in a specific category
 * 
 * @param {string} category - Category name
 * @returns {Array} Tools in that category
 */
export function getToolsByCategory(category) {
    return Array.from(toolRegistry.values()).filter(tool => tool.category === category);
}

/**
 * Remove a tool from the registry
 * 
 * @param {string} name - Tool identifier to remove
 */
export function unregisterTool(name) {
    toolRegistry.delete(name);
}

/**
 * Clear all registered tools
 */
export function clearRegistry() {
    toolRegistry.clear();
}

/**
 * Initialize default tools from current application 
 */
export function initializeDefaultTools() {
    // This would be populated with initial tool data when the app loads
    // Tools are actually defined in app.py in Python TOOLS dictionary
}


// Initialize registry
initializeDefaultTools();

// Export for module use
export { toolRegistry };
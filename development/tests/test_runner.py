#!/usr/bin/env python3
"""
Simple test runner for Iprix's Spells development.
This serves as the initial test infrastructure for development phases.
"""

import sys
import os

# Add the current directory to Python path so we can import our modules
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

def run_tests():
    """Run basic tests to confirm environment is working."""
    print("Running development infrastructure tests...")
    
    # Test that basic imports work
    try:
        import app
        print("✓ Main application imports successfully")
    except Exception as e:
        print(f"✗ Failed to import main application: {e}")
        return False
        
    # Test shared utilities can be imported
    try:
        from shared.utilities.helpers import generateId, formatBytes
        print("✓ Shared utilities available")
    except Exception as e:
        print(f"✗ Failed to import shared utilities: {e}")
        return False
    
    # Test that main application files exist
    required_files = [
        'app.py',
        'auth.py', 
        'storage.py',
        'chat.py',
        'board.py'
    ]
    
    for file in required_files:
        if os.path.exists(file):
            print(f"✓ Required file exists: {file}")
        else:
            print(f"✗ Missing required file: {file}")
            return False
            
    print("All infrastructure tests passed!")
    return True

if __name__ == "__main__":
    success = run_tests()
    sys.exit(0 if success else 1)
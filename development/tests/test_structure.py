"""
Tests for the development infrastructure setup.
"""

import os
import sys

def test_development_structure():
    """Test that development structure is properly set up."""
    
    # Test shared directories exist
    shared_dirs = [
        'development/shared/components',
        'development/shared/utilities', 
        'development/shared/styles',
        'development/shared/documentation'
    ]
    
    for directory in shared_dirs:
        if os.path.exists(directory):
            print(f"✓ Directory exists: {directory}")
        else:
            print(f"✗ Missing directory: {directory}")
            return False
    
    # Test that key files are present
    test_files = [
        'development/shared/utilities/helpers.js',
        'development/shared/documentation/structure.md'
    ]
    
    for file in test_files:
        if os.path.exists(file):
            print(f"✓ File exists: {file}")
        else:
            print(f"✗ Missing file: {file}")
            return False
            
    # Test that test runner is functional 
    try:
        from development.tests.test_runner import run_tests
        result = run_tests()
        if result:
            print("✓ Test runner functional")
        else:
            print("✗ Test runner failed")
            return False
    except Exception as e:
        print(f"✗ Test runner error: {e}")
        return False
        
    print("All structure tests passed!")
    return True

if __name__ == "__main__":
    success = test_development_structure()
    sys.exit(0 if success else 1)
#!/usr/bin/env python3
"""
Test to verify Phase 1 infrastructure completion for Iprix's Spells.

This verifies that we have correctly established 
the development infrastructure as specified in Phase 1 requirements.
"""

def test_development_structure():
    """Test that all required development directories are present."""
    
    import os
    
    # Test core development structure
    expected_dirs = [
        'development/shared/components',
        'development/shared/utilities', 
        'development/shared/styles',
        'development/shared/documentation',
        'development/phase-01',
        'development/phase-02', 
        'development/phase-03',
        'development/phase-04',
        'development/phase-05',
        'development/tests'
    ]
    
    print("Checking Phase 1 Development Structure...")
    
    all_good = True
    for directory in expected_dirs:
        if os.path.exists(directory):
            print(f"✓ {directory}")
        else:
            print(f"✗ Missing: {directory}")
            all_good = False
    
    return all_good

def test_shared_components():
    """Test that shared components are properly structured."""
    
    import os
    
    # Test shared component directories  
    shared_dirs = [
        'development/shared/components',
        'development/shared/utilities',
        'development/shared/styles'
    ]
    
    print("\nChecking Shared Components Structure...")
    
    all_good = True
    for directory in shared_dirs:
        if os.path.exists(directory):
            print(f"✓ {directory}")
        else:
            print(f"✗ Missing: {directory}")  
            all_good = False
    
    # Test that key files exist
    expected_files = [
        'development/shared/utilities/helpers.js',
        'development/shared/documentation/structure.md'
    ]
    
    for file in expected_files:
        if os.path.exists(file):
            print(f"✓ {file}")
        else:
            print(f"✗ Missing: {file}")
            all_good = False
            
    return all_good

def main():
    """Run all Phase 1 tests."""
    
    print("Phase 1 - Development Infrastructure Tests")
    print("=" * 50)
    
    structure_ok = test_development_structure()
    components_ok = test_shared_components() 
    
    print("\n" + "=" * 50)
    
    if structure_ok and components_ok:
        print("✓ ALL PHASE 1 TESTS PASSED")
        print("Development infrastructure correctly established.")
        return True
    else:
        print("✗ SOME TESTS FAILED")
        print("Development infrastructure incomplete.")
        return False

if __name__ == "__main__":
    import sys
    success = main()
    sys.exit(0 if success else 1)
*** Settings ***
Documentation    Test cases for copilot-desktop snap
Resource         kvm.resource


*** Test Cases ***
Copilot Desktop Launches And Renders
    [Documentation]    Verify copilot-desktop snap launches and renders a UI on Mir
    [Tags]    smoke    yarf:certification_status: blocker
    Log Screenshot

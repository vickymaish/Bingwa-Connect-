# MikroTik setup for the ISP billing system (RouterOS v7.1 or newer).
# Paste into WinBox > New Terminal AFTER the Hotspot exists (step 0 below).
# Replace these placeholders first:
#   SERVER_IP          the billing server's IP as the router sees it (e.g. 192.168.88.10)
#   ROUTER_IP          the router address the server connects to   (e.g. 192.168.88.1)
#   PORTAL_HOST        the portal's hostname, without https://      (e.g. pay.example.co.ke)
#   STRONG_PASSWORD    a new password for the billing account
#
# Step 0 (once, interactive): /ip hotspot setup
#   Pick the interface or bridge customers connect to and accept the defaults.

# 1. A dedicated account for the billing system, usable only from the server.
/user group add name=billing policy=read,write,api,rest-api comment="ISP billing system"
/user add name=billing group=billing password=STRONG_PASSWORD address=SERVER_IP/32 comment="ISP billing system"

# 2. HTTPS for the REST API, with a certificate valid for the router's IP.
/certificate add name=billing-api common-name=ROUTER_IP subject-alt-name=IP:ROUTER_IP days-valid=3650
/certificate sign billing-api
/ip service set www-ssl disabled=no certificate=billing-api address=SERVER_IP/32
# Then export it for the server and set MIKROTIK_CA_FILE to the downloaded file:
/certificate export-certificate billing-api export-passphrase=""

# 3. Let unpaid devices reach the payment portal.
/ip hotspot walled-garden add dst-host=PORTAL_HOST comment="ISP billing portal"
/ip hotspot walled-garden ip add action=accept dst-address=SERVER_IP comment="ISP billing server"

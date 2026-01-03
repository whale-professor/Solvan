#!/usr/bin/env python3

"""
Solana Vanity Address Generator - Fast Optimized Backend
No hanging - early exit with proper multiprocessing
"""

import sys
import json
import time
import multiprocessing
import base58
from solders.keypair import Keypair

NUM_PROCESSES = max(4, multiprocessing.cpu_count())

def find_vanity_address(process_id, search_type, vanity_string, result_queue, stop_flag, case_sensitive):
    """Worker process - exits immediately when match found"""
    counter = 0
    start_time = time.time()
    
    try:
        string_to_check = vanity_string if case_sensitive else vanity_string.lower()
        
        while True:
            # Early exit if another process found match
            if stop_flag.value == 1:
                return
            
            keypair = Keypair()
            address = str(keypair.pubkey())
            counter += 1
            
            # Check for match
            address_check = address if case_sensitive else address.lower()
            
            if (search_type == 'prefix' and address_check.startswith(string_to_check)) or \
               (search_type == 'suffix' and address_check.endswith(string_to_check)):
                
                # Found match - signal stop and return result
                stop_flag.value = 1
                
                complete_keypair = bytes(keypair)
                result = {
                    "address": address,
                    "privateKeyBytes": list(complete_keypair),
                    "privateKeyBase58": base58.b58encode(complete_keypair).decode('utf-8'),
                    "privateKeyHex": complete_keypair.hex(),
                    "attempts": counter,
                    "time": round(time.time() - start_time, 2)
                }
                
                result_queue.put(result)
                return
    
    except Exception as e:
        print(f"[ERROR P{process_id}] {e}", file=sys.stderr)

def main():
    if len(sys.argv) < 8:
        print(json.dumps({"error": "Missing arguments"}))
        sys.exit(1)
    
    search_type = sys.argv[2]
    vanity_string = sys.argv[4]
    case_sensitive = sys.argv[6] == 'true'
    
    with multiprocessing.Manager() as manager:
        stop_flag = manager.Value('i', 0)
        result_queue = manager.Queue()
        
        processes = []
        for i in range(NUM_PROCESSES):
            p = multiprocessing.Process(
                target=find_vanity_address,
                args=(i, search_type, vanity_string, result_queue, stop_flag, case_sensitive)
            )
            p.daemon = True
            p.start()
            processes.append(p)
        
        result = None
        try:
            result = result_queue.get(timeout=3600)
        except:
            pass
        
        # Kill all processes immediately
        for p in processes:
            try:
                if p.is_alive():
                    p.terminate()
                    p.join(timeout=0.5)
                    if p.is_alive():
                        p.kill()
            except:
                pass
        
        if result:
            print(json.dumps(result))
            sys.exit(0)
        else:
            print(json.dumps({"error": "Generation failed"}))
            sys.exit(1)

if __name__ == '__main__':
    main()
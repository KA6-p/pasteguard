import requests
import flask_gpt_helper

def run(cmd):
    import subprocess
    return subprocess.run(cmd, shell=True)



